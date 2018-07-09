/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import {HTTPRequest} from './vo/metrics/HTTPRequest';
import FactoryMaker from '../core/FactoryMaker';
import MediaPlayerModel from './models/MediaPlayerModel';
import ErrorHandler from './utils/ErrorHandler.js';
import Debug from '../core/Debug';

/**
 * @module XHRLoader
 * @description Manages download of resources via HTTP.
 * @param {Object} cfg - dependancies from parent
 */
function XHRLoader(cfg) {
    const context = this.context;

    //const log = Debug(context).getInstance().log;
    const mediaPlayerModel = MediaPlayerModel(context).getInstance();

    const errHandler = cfg.errHandler;
    const metricsModel = cfg.metricsModel;
    const requestModifier = cfg.requestModifier;

    let instance;
    let xhrs;
    let delayedXhrs;
    let retryTimers;
    let downloadErrorToRequestTypeMap;
    let log = Debug(context).getInstance().log;

    const deadXhrTimers = (function DeadXhrTimers() {
        var list = [];
        var inst = {
            set: function (cb, timeMs) {
                let item = setTimeout(cb, timeMs);
                list.push(item);

                return item;
            },
            clear: function (item) {
                clearTimeout(item);
                inst.remove(item);
            },
            clearAll: function () {
                list.forEach(t => clearTimeout(t));
                list = [];
            },
            remove: function (item) {
                let idx = list.indexOf(item);
                if (-1 !== idx) {
                    list.splice(idx, 1);
                }
            },
            removeAll: function () {
                list = [];
            }
        };

        return inst;
    })();


    function setup() {
        xhrs = [];
        delayedXhrs = [];
        retryTimers = [];
        deadXhrTimers.clearAll();

        downloadErrorToRequestTypeMap = {
            [HTTPRequest.MPD_TYPE]:                         ErrorHandler.DOWNLOAD_ERROR_ID_MANIFEST,
            [HTTPRequest.XLINK_EXPANSION_TYPE]:             ErrorHandler.DOWNLOAD_ERROR_ID_XLINK,
            [HTTPRequest.INIT_SEGMENT_TYPE]:                ErrorHandler.DOWNLOAD_ERROR_ID_INITIALIZATION,
            [HTTPRequest.MEDIA_SEGMENT_TYPE]:               ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT,
            [HTTPRequest.INDEX_SEGMENT_TYPE]:               ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT,
            [HTTPRequest.BITSTREAM_SWITCHING_SEGMENT_TYPE]: ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT,
            [HTTPRequest.OTHER_TYPE]:                       ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT
        };
    }

    function internalLoad(config, remainingAttempts) {

        var request = config.request;
        var xhr = new XMLHttpRequest();
        var traces = [];
        var firstProgress = true;
        var totalProgressCount = 0; // Rik 201712
        var needFailureReport = true;
        const requestStartTime = new Date();
        var lastTraceTime = requestStartTime;
        var lastTraceReceivedCount = 0;

        // Rik 201712 - Adding a timeout to detect a connection that stops providing data.
        const DEAD_CONNECTION_TIMEOUT = 333;
        const DEAD_CONNECTION_INITIAL_CONNECT_MIN_TIMEOUT = 2500;
        const DEAD_CONNECTION_KILL_THRESHOLD = 4000;
        const DEAD_CONNECTION_GRACE_PERIOD = 500;
        const DEAD_CONNECTION_MIN_BITRATE = 10000;
        var deadConnectionTimer = null; //< We'll have one per pending load.
        var deadProgressTimes = []; //< list of the times at which bytes were loaded for ths xhr, used for dead check
        var deadProgressBytes = []; //< number of bytes download at each progress event for this xhr, used for dead check
        var deadSinceTime = Number.NaN; //< When did we notice that the connection appears dead (will be re-Nan'ed if progress resumes)
        const checkDeadConnection = function on_dead_connection_timeout() {
            deadXhrTimers.remove(deadConnectionTimer);
            deadConnectionTimer = null;

            if ('undefined' === typeof xhr.onerror) {
                log('[', request.mediaType, '] XHR dead connection timer fired, but XHR appears already cancelled.');
                return;
            }

            let doError = false;
            if (firstProgress) {
                // Didn't get to first progress in allowed time.  abandon
                log('[', request.mediaType, '] Taking too long for XHR to connect');

                doError = true;
            }
            else {
                // If few progress events are being generated make some extra ones, to tickle the abandonment rule
                log('[', request.mediaType, '] XHR slow at generating progress events');
                if (config.progress) {
                    try {
                        config.progress({fake: true});
                    }
                    catch (err) {
                    }
                }

                let now = Date.now();
                if (isNaN(deadSinceTime)) {
                    deadSinceTime = now;
                }

                if ( (now - deadSinceTime) >= DEAD_CONNECTION_KILL_THRESHOLD) {
                    log('[', request.mediaType, '] Taking too long for XHR to deliver bytes');
                    doError = true;
                }
            }

            if (doError) {
                xhr.abort();
            }
            else {
                deadConnectionTimer = deadXhrTimers.set(checkDeadConnection, DEAD_CONNECTION_TIMEOUT);
            }
        };

        function isEffectivelyDead() {
            if (deadProgressTimes.length >= 2) {
                let t2 = deadProgressTimes.pop();
                let t1 = deadProgressTimes.pop();
                deadProgressTimes = [];

                let b2 = deadProgressBytes.pop();
                let b1 = deadProgressBytes.pop();
                deadProgressBytes = [];

                if ( (t2 - requestStartTime) < DEAD_CONNECTION_GRACE_PERIOD ) {
                    // Allow some time for connection to start
                    return false;
                }

                if (isNaN(b2)) {
                    // Effectively dead if no bytecount after two progress events?
                    return true;
                }

                let elapsedTime = t2 - t1;
                let downloadedBytes = b2 - b1;

                let bps = (downloadedBytes / elapsedTime) * 1000; // time from Date() object was in mS.

                return (bps <= DEAD_CONNECTION_MIN_BITRATE);
            }

            return false;
        }

        const handleLoaded = function (success) {
            var latency,
                download;

            needFailureReport = false;

            request.requestStartDate = requestStartTime;
            request.requestEndDate = new Date();
            request.firstByteDate = request.firstByteDate || requestStartTime;

            latency = (request.firstByteDate.getTime() - request.requestStartDate.getTime());
            download = (request.requestEndDate.getTime() - request.firstByteDate.getTime());

            var downloadedBytes = 0;
            if ('string' === typeof (request.range) && request.range !== 'null') {
                //FIXME: range should never be a string containing the word 'null'!
                var rangeOffsets = request.range.split('-');
                try {
                    downloadedBytes = parseInt(rangeOffsets[1]) - parseInt(rangeOffsets[0]) + 1;
                } catch (err) {
                    log('XHRLoader : Problem parsing request range');
                }
            }
            var Throughput = (downloadedBytes * 8 * 1000) / (latency + download);

            log('[' + request.mediaType + ']', (success ? 'loaded ' : 'failed ') + ':' + 'index = ' + request.index + ':' + request.type + ':' + request.startTime + ' (' + xhr.status + ', ' + latency + 'ms, ' + download + 'ms) Throughput = ' + Throughput);
            log('Request generated ', totalProgressCount, ' progress events'); // Rik 201712

            if (!request.checkExistenceOnly) {
                metricsModel.addHttpRequest(
                    request.mediaType,
                    null,
                    request.type,
                    request.url,
                    xhr.responseURL || null,
                    request.serviceLocation || null,
                    request.range || null,
                    request.requestStartDate,
                    request.firstByteDate,
                    request.requestEndDate,
                    xhr.status,
                    request.duration,
                    xhr.getAllResponseHeaders(),
                    success ? traces : null
                );
            }
        };

        const onloadend = function () {
            if (null !== deadConnectionTimer) {
                deadXhrTimers.clear(deadConnectionTimer);
                deadConnectionTimer = null;
            }

            if (xhrs.indexOf(xhr) === -1) {
                log('onloadend called, but XHR not in xhrs list'); //RIK 201712
                return;
            } else {
                xhrs.splice(xhrs.indexOf(xhr), 1);
            }

            if (needFailureReport) {
                log('XHR request failed'); //RIK 201712
                handleLoaded(false);

                if (remainingAttempts > 0) {
                    remainingAttempts--;
                    retryTimers.push(
                        setTimeout(function () {
                            internalLoad(config, remainingAttempts);
                        }, mediaPlayerModel.getRetryIntervalForType(request.type))
                    );
                } else {
                    log('XHR request exceeded retry max, failing'); //RIK 201712

                    errHandler.downloadError(
                        downloadErrorToRequestTypeMap[request.type],
                        request.url,
                        request
                    );

                    if (config.error) {
                        config.error(request, 'error', xhr.statusText);
                    }

                    if (config.complete) {
                        config.complete(request, xhr.statusText);
                    }
                }
            }
        };

        const progress = function (event) {
            var currentTime = new Date();
            ++totalProgressCount; // Rik 201712

            if (null !== deadConnectionTimer) {
                deadXhrTimers.clear(deadConnectionTimer);
                deadConnectionTimer = deadXhrTimers.set(checkDeadConnection, DEAD_CONNECTION_TIMEOUT);
            }

            if (firstProgress) {
                log('Got first progress event'); // Rik 201712
                firstProgress = false;
                if (!event.lengthComputable ||
                    (event.lengthComputable && event.total !== event.loaded)) {
                    request.firstByteDate = currentTime;
                }

                // Rik 201712 - see what the headers are, may give us a clue what went wrong.
                let headers = '...';
                try {
                    headers = xhr.getAllResponseHeaders().split('\n').join(' - ');
                }
                catch (err) {
                    headers = 'headers caused a problem: ' + err.message;
                }

                //log('XHR response headers: ', headers);
            }

            if (event.lengthComputable) {
                request.bytesLoaded = event.loaded;
                request.bytesTotal = event.total;
            }

            traces.push({
                s: lastTraceTime,
                d: currentTime.getTime() - lastTraceTime.getTime(),
                b: [event.loaded ? event.loaded - lastTraceReceivedCount : 0]
            });

            lastTraceTime = currentTime;
            lastTraceReceivedCount = event.loaded;

            deadProgressTimes.push(currentTime.getTime());
            deadProgressBytes.push(event.lengthComputable ? event.loaded : Number.NaN);
            if (!isEffectivelyDead()) {
                deadSinceTime = Number.NaN;
            }
            else {
                if (isNaN(deadSinceTime)) {
                    deadSinceTime = currentTime.getTime();
                }
            }

            if (config.progress) {
                config.progress();
            }
        };

        const onload = function () {
            if (null !== deadConnectionTimer) {
                deadXhrTimers.clear(deadConnectionTimer);
                deadConnectionTimer = null;
            }

            if (xhr.status >= 200 && xhr.status <= 299) {
                handleLoaded(true);

                if (config.success) {
                    config.success(xhr.response, xhr.statusText, xhr);
                }

                if (config.complete) {
                    config.complete(request, xhr.statusText);
                }
            }
            else {
                log('[', request.mediaType, '] onload failure due to HTTP status code: ', xhr.status);
            }
        };

        try {
            log('[' + request.mediaType + ']' + ' XhttpRequest : ' + request.url);
            log('[' + request.mediaType + ']' + ' XhhtpRequest Range : bytes= ' + request.range + ' request.index = ' + request.index);

            var requestData = {
                url: request.url,
                range: (!!request.range) ? request.range : null,
                headers: {
                    Range: 'bytes=' + request.range
                }
            };
            if (!!requestModifier.modifyRequestData) {
                // New method proposed by VUDU.  Hence doing existance check to protect legacy implementations that will not have modifyRequestData() method.
                requestModifier.modifyRequestData(requestData);
            }
            const modifiedUrl = requestModifier.modifyRequestURL(requestData.url);
            const verb = request.checkExistenceOnly ? 'HEAD' : 'GET';

            xhr.open(verb, modifiedUrl, true);

            if (request.responseType) {
                xhr.responseType = request.responseType;
            }

            if (!request.requestStartDate) {
                request.requestStartDate = requestStartTime;
            }

            xhr = requestModifier.modifyRequestHeader(xhr);

            // Add all headers to XHR request.  Both range header pass in here, plus any additional headers created by requestModifier.
            for (var key in requestData.headers) {
                xhr.setRequestHeader(key, requestData.headers[key]);
            }
            xhr.withCredentials = mediaPlayerModel.getXHRWithCredentials();

            xhr.onload = onload;
            xhr.onloadend = onloadend;
            xhr.onerror = onloadend;
            xhr.onprogress = progress;

            if (!!mediaPlayerModel.getNetworkTimeoutForType) {
                let requestTimeout =  mediaPlayerModel.getNetworkTimeoutForType(config.request.mediaType);
                if (!!requestTimeout && !isNaN(requestTimeout)) {
                    xhr.timeout = requestTimeout;
                }
            }

            // Adds the ability to delay single fragment loading time to control buffer.
            let now = new Date().getTime();
            if (isNaN(request.delayLoadingTime) || now >= request.delayLoadingTime) {
                // no delay - just send xhr
                log('XHR loading now'); //RIK 201712

                xhrs.push(xhr);
                xhr.send();

                let deadConnectTimeout = (Number.isNaN(request.duration)) ?
                    // Init data doesn't have a duration
                    DEAD_CONNECTION_INITIAL_CONNECT_MIN_TIMEOUT
                    //scaled up by 25%, convert to mS.  Respect minimum
                    : Math.max(DEAD_CONNECTION_INITIAL_CONNECT_MIN_TIMEOUT, request.duration * 1.25 * 1000);

                deadConnectionTimer = deadXhrTimers.set(checkDeadConnection, deadConnectTimeout);
            } else {
                log('XHR loading after delay: ', (request.delayLoadingTime - now)); //RIK 201712
                // delay
                let delayedXhr = {xhr: xhr};
                delayedXhrs.push(delayedXhr);
                delayedXhr.delayTimeout = setTimeout(function () {
                    if (delayedXhrs.indexOf(delayedXhr) === -1) {
                        log('delayedXhrs no longer contains delayedXhr after delay'); //RIK 201712
                        return;
                    } else {
                        delayedXhrs.splice(delayedXhrs.indexOf(delayedXhr), 1);
                    }
                    try {
                        xhrs.push(delayedXhr.xhr);
                        delayedXhr.xhr.send();
                    } catch (e) {
                        log('Delayed XHR load threw: ', e.message); //RIK 201712
                        delayedXhr.xhr.onerror();
                    }
                }, (request.delayLoadingTime - now));
            }

        } catch (e) {
            log('XHR load threw: ', e.message); //RIK 201712
            xhr.onerror();
        }
    }

    /**
     * Initiates a download of the resource described by config.request
     * @param {Object} config - contains request (FragmentRequest or derived type), and callbacks
     * @memberof module:XHRLoader
     * @instance
     */
    function load(config) {
        if (config.request) {
            internalLoad(
                config,
                mediaPlayerModel.getRetryAttemptsForType(
                    config.request.type
                )
            );
        }
    }

    /**
     * Aborts any inflight downloads
     * @memberof module:XHRLoader
     * @instance
     */
    function abort() {
        log('aborting XHR requests'); //RIK 201712
        retryTimers.forEach(t => clearTimeout(t));
        retryTimers = [];

        delayedXhrs.forEach(x => clearTimeout(x.delayTimeout));
        delayedXhrs = [];

        xhrs.forEach(x => {
            // abort will trigger onloadend which we don't want
            // when deliberately aborting inflight requests -
            // set them to undefined so they are not called
            x.onloadend = x.onerror = x.onprogress = undefined;
            x.abort();
        });
        xhrs = [];

        deadXhrTimers.clearAll();
    }

    instance = {
        load: load,
        abort: abort
    };

    setup();

    return instance;
}

XHRLoader.__dashjs_factory_name = 'XHRLoader';

const factory = FactoryMaker.getClassFactory(XHRLoader);
export default factory;
