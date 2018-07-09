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
import XHRLoader from './XHRLoader';
import HeadRequest from './vo/HeadRequest';
import Error from './vo/Error';
import EventBus from './../core/EventBus';
import Events from './../core/events/Events';
import FactoryMaker from '../core/FactoryMaker';
import Debug from '../core/Debug';

const FRAGMENT_LOADER_ERROR_LOADING_FAILURE = 1;
const FRAGMENT_LOADER_ERROR_NULL_REQUEST = 2;
const FRAGMENT_LOADER_MESSAGE_NULL_REQUEST = 'request is null';

function FragmentLoader(config) {

    const context = this.context;
    const eventBus = EventBus(context).getInstance();

    let instance,
        xhrLoader;

    let fragCount = 0;

    let log = Debug(context).getInstance().log;

    const throttler = (function Throttler() {

        var timer = null;
        var task;
        var rate;
        var argsets = [];

        function setup(initRate, initTask) {
            task = initTask;
            rate = initRate;
            argsets = [];

            if (null !== timer) {
                clearTimeout(timer);
                timer = null;
            }
        }

        function call() {
            let args = [];
            args.push.apply(args, arguments);
            argsets.push(args);

            if (null !== timer) {
                return;
            }
            else {
                doAction(argsets);
            }

        }

        function doAction() {
            if (0 === argsets.length) {
                timer = null;
            }
            else {
                try {
                    let a = argsets;
                    argsets = [];
                    if ('function' === typeof task) {
                        task(a);
                    }
                }
                catch (err) {
                }

                timer = setTimeout(doAction, rate);
            }
        }

        function end() {
            if (null !== timer) {
                clearTimeout(timer);
                doAction();
            }
            if (null !== timer) {
                clearTimeout(timer);
                timer = null;
            }
            task = null;
        }


        return {
            setup: setup,
            call: call,
            end: end
        };


    })();


    function setup() {
        xhrLoader = XHRLoader(context).create({
            errHandler: config.errHandler,
            metricsModel: config.metricsModel,
            requestModifier: config.requestModifier
        });

        throttler.setup(1000, function (argsets) {
            log('===== Throttled FragmentLoader messages =====');
            argsets.forEach(function (logbitsarglist) {
                let logbits = logbitsarglist[0]; // each argset gets preserved as an array, but we have only single item...
                logbits.forEach(function (logMsg) {
                    log(logMsg);
                });
            });
        });
    }

    function checkForExistence(request) {
        const report = function (success) {
            eventBus.trigger(
                Events.CHECK_FOR_EXISTENCE_COMPLETED, {
                    request: request,
                    exists: success
                }
            );
        };

        if (request) {
            let headRequest = new HeadRequest(request.url);

            xhrLoader.load({
                request: headRequest,
                success: function () {
                    report(true);
                },
                error: function () {
                    report(false);
                }
            });
        } else {
            report(false);
        }
    }

    function load(request) {
        let fragIndex = fragCount++;
        const report = function (data, error) {
            eventBus.trigger(Events.LOADING_COMPLETED, {
                request: request,
                response: data || null,
                error: error || null,
                sender: instance
            });
        };

        var monitor = {
            interval: null,
            tStart: Date.now(),
            tFirstData: null
        };

        const m = function (reason) {
            let logbits = [];
            const logpush = function () {
                let msg = [].join.call(arguments, '');
                logbits.push(msg);
            };

            logpush('Reason:' + reason);
            let elapsed = Date.now() - monitor.tStart;
            elapsed /= 1000;

            switch (reason){
                case 'progress':
                    if (null === monitor.tFirstData) {
                        monitor.tFirstData = Date.now();
                    }
                    break;
                case 'success':
                case 'error':
                    if ('string' !== typeof fragIndex) {
                        fragIndex = '' + fragIndex + ' (' + reason + ')';
                    }
                    clearInterval(monitor.interval);
                    monitor.interval = null;
                    break;
                default:
                    if (!!request.duration) {
                        if (elapsed > request.duration) {
                            // Handling periodic ping...
                            logpush('Download taking too long - should generate an error');
                        }
                        if (elapsed > (10 * request.duration) ) {
                            logpush('ALERT : Killing monitor on fragment with crazy elapsed time.  Fragment Request # ', fragIndex);
                            clearInterval(monitor.interval);
                            monitor.interval = null;
                        }
                    }
                    break;
            }

            /*
            logpush('Fragment Request # ', fragIndex, ' media: ', request.mediaType);
            logpush('First Byte (msec): ', (null === monitor.tFirstData) ? 'waiting...' : (monitor.tFirstData - monitor.tStart));
            logpush('Elapsed time (secs): ', elapsed);
            logpush('Bytes loaded: ', request.bytesLoaded);
            logpush('Frag Duration (secs): ', request.duration, '; Frag size (bytes): ', isNaN(request.bytesTotal) ? 'unknown' : request.bytesTotal);

            throttler.call(logbits);
            */
        };


        if (request) {
            monitor.interval = setInterval(m, 500);
            xhrLoader.load({
                request: request,
                progress: function (obj) {
                    let ptype = 'progress';
                    if (!!obj && !!obj.fake) {
                        ptype = 'fake progress';
                    }
                    m(ptype);
                    eventBus.trigger(Events.LOADING_PROGRESS, {
                        request: request
                    });
                },
                success: function (data) {
                    m('success');
                    report(data);
                },
                error: function (xhr, statusText, errorText) {
                    m('error');
                    report(
                        undefined,
                        new Error(
                            FRAGMENT_LOADER_ERROR_LOADING_FAILURE,
                            errorText,
                            statusText
                        )
                    );
                }
            });
        } else {
            report(
                undefined,
                new Error(
                    FRAGMENT_LOADER_ERROR_NULL_REQUEST,
                    FRAGMENT_LOADER_MESSAGE_NULL_REQUEST
                )
            );
        }
    }

    function abort() {
        if (xhrLoader) {
            xhrLoader.abort();
        }
    }

    function reset() {
        if (xhrLoader) {
            xhrLoader.abort();
            xhrLoader = null;
        }

        throttler.end();
    }

    instance = {
        checkForExistence: checkForExistence,
        load: load,
        abort: abort,
        reset: reset
    };

    setup();

    return instance;
}

FragmentLoader.__dashjs_factory_name = 'FragmentLoader';

const factory = FactoryMaker.getClassFactory(FragmentLoader);
factory.FRAGMENT_LOADER_ERROR_LOADING_FAILURE = FRAGMENT_LOADER_ERROR_LOADING_FAILURE;
factory.FRAGMENT_LOADER_ERROR_NULL_REQUEST = FRAGMENT_LOADER_ERROR_NULL_REQUEST;
export default factory;
