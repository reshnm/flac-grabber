
'use strict';

const util = require('util');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');
const flac = require('flac-metadata');
const mime = require('mime-types');
const sizeOf = require('image-size');
const request = require('request');
const shell = require('shelljs');
const filenamify = require('filenamify');


function MetaData(trackInfo, imageLocation) {
    const comments = [];

    for (var key in trackInfo) {
        comments.push(`${key.toUpperCase()}=${trackInfo[key]}`);
    }

    const vendor = 'reference libFLAC 1.2.1 20070917'
    this.mdbVorbis = flac.data.MetaDataBlockVorbisComment.create(true, vendor, comments);

    const image = fs.readFileSync(imageLocation);
    const imageMimeType = mime.lookup(imageLocation);
    const imageSize = sizeOf(imageLocation);
    this.dbPicture = flac.data.MetaDataBlockPicture.create(false, 3 /* cover front */, imageMimeType, '', imageSize.width, imageSize.height, 0, 0, image);

    this.processor = new flac.Processor();
    this.processor.on('preprocess', this.onPreProcess.bind(this));
    this.processor.on('error', (error) => {
        console.error(`FLAC processor error: ${error}`)
    });
}

MetaData.prototype.publish = function(reader, writer) {
    reader.pipe(this.processor).pipe(writer);
}

MetaData.prototype.onPreProcess = function(mdb) {
    if (mdb.type === flac.Processor.MDB_TYPE_VORBIS_COMMENT) {
        mdb.remove();
    }

    if (mdb.type === flac.Processor.MDB_TYPE_PICTURE) {
        mdb.remove();
    }

    if (mdb.removed || mdb.isLast) {
        this.processor.push(this.dbPicture.publish());
        this.processor.push(this.mdbVorbis.publish());
    }
}


const args = process.argv.slice(2);
var volumioAddress = 'http://192.168.0.100:3000';
var flacDestination = 'x:\\flac';

if (args.length >= 1) {
    volumioAddress = args[0];
}

if (args.length >= 2) {
    flacDestination = args[1];
}

if (!fs.existsSync(flacDestination)) {
    console.error(`Destination path ${flacDestination} doesn't exist!`);
    process.exit(1);
}

const volumioClient = io.connect(volumioAddress);
volumioClient.on('pushState', onVolumioState);
// request the value of the current player state
volumioClient.emit('getState', '');

const grabIds = new Map();


String.prototype.replaceAll = function(search, replacement) {
    var target = this;
    return target.trim().split(search).join(replacement);
};


function onStreamError(grabId, error) {
    console.error(`error: ${error} for grabId="${grabId}"`);
    grabIds.delete(grabId);
}


function onAlbumArtDownloaded(grabId, albumArtFile, trackInfo, trackURL, trackTargetFile) {
    const trackReader = request(trackURL);
    const trackWriter = fs.createWriteStream(trackTargetFile);

    trackReader.on('error', onStreamError.bind(this, grabId));
    trackWriter.on('error', onStreamError.bind(this, grabId))
               .on('finish', function(grabId) {
                   fs.unlinkSync(albumArtFile);
                   console.log(`grabId="${grabId}" finished`);
                }.bind(this, grabId));

    const md = new MetaData(trackInfo, albumArtFile);
    md.publish(trackReader, trackWriter);
}


function getStringOrEmpty(o, s) {
    if (o.hasOwnProperty(s)) {
        return o[s];
    }
    return '';
}


function onVolumioState(state) {
    //console.log(`onVolumioState ${util.inspect(state)}`);

    if (state.status != 'play') {
        return;
    }

    var title = getStringOrEmpty(state, 'title');
    var album = getStringOrEmpty(state, 'album');
    var artist = getStringOrEmpty(state, 'artist');
    const albumArtURL = getStringOrEmpty(state, 'albumart');
    const trackURL = getStringOrEmpty(state, 'uri');
    var trackNumber = getStringOrEmpty(state, 'position');

    if (typeof trackNumber == 'string' || trackNumber instanceof String) {
        trackNumber = parseInt(trackNumber, 10) + 1;
    } else {
        trackNumber += 1;
    }

    if (!title || !album || !artist || !albumArtURL || !trackURL) {
        return;
    }

    if (!trackURL.includes('qobuz') || !trackURL.startsWith('http') || !albumArtURL.startsWith('http')) {
        return;
    }

    const trackInfo = {
        TITLE: title,
        ALBUM: album,
        ARTIST: artist,
        TRACKNUMBER: trackNumber
    };

    title = filenamify(title.replaceAll(' ', '_'));
    album = filenamify(album.replaceAll(' ', '_'));
    artist = filenamify(artist.replaceAll(' ', '_'));

    const grabId = `${title}_${album}_${artist}`;

    console.log(`grabId="${grabId}"`)

    if (grabIds.has(grabId)) {
        console.log(`grabId="${grabId}" already exists, skip`);
        return;
    }

    const tmpPath = path.join(flacDestination, 'tmp');
    const albumArtTempFile = path.join(tmpPath, `${grabId}_albumart.${path.extname(albumArtURL)}`);
    const trackTargetPath = path.join(flacDestination, artist.replaceAll(' ', '_'), album.replaceAll(' ', '_'));
    const trackTargetFile = path.join(trackTargetPath, `${trackNumber}_${title.replaceAll(' ', '_')}.flac`);

    if (fs.existsSync(trackTargetFile)) {
        console.log(`file for grabId="${grabId}" already exists, skip`);
        return;
    }

    if (!fs.existsSync(trackTargetPath)) {
        shell.mkdir('-p', trackTargetPath);
    }

    if (!fs.existsSync(tmpPath)) {
        shell.mkdir('-p', tmpPath);
    }

    console.log(`start grabbing grabId="${grabId}"`);

    grabIds.set(grabId, true);

    const albumArtWriter = fs.createWriteStream(albumArtTempFile);

    albumArtWriter
        .on('finish', onAlbumArtDownloaded.bind(
            this,
            grabId,
            albumArtTempFile,
            trackInfo,
            trackURL,
            trackTargetFile))
        .on('error', onStreamError.bind(this, grabId));
    request(albumArtURL)
        .on('error', onStreamError.bind(this, grabId))
        .pipe(albumArtWriter);
};
