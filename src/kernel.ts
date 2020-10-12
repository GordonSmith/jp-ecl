#!/usr/bin/env node

var console = require("console");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var Kernel = require("jp-kernel");

var transpile = require("./workunit").transpile;

// import { locateAllClientTools } from "@hpcc-js/comms";

interface KernelConfig {
    // Frontend connection file
    connection?: Object;

    // Session current working directory
    cwd: string;

    // Enable debug mode
    debug?: boolean;

    // Do not show execution result
    hideExecutionResult?: boolean;

    // Do not show undefined results
    hideUndefined: boolean;

    // Content of kernel_info_reply message
    kernelInfoReply?: Object;

    // Message protocol version
    protocolVersion: string;

    // Callback invoked at session startup.
    // This callback can be used to setup a session; e.g. to register a require extensions.
    startupCallback?: () => void;

    // Path to a script to be run at startup.
    // Path to a folder also accepted, in which case all the scripts in the folder will be run.
    startupScript?: string;

    // If defined, this function transpiles the request code into Javascript that can be run by the Node.js session.
    transpile?: (code: string) => string;
}

// Parse command arguments
var config = parseCommandArguments();


// Setup logging helpers
var log;
var dontLog = function dontLog() { };
var doLog = function doLog() {
    process.stderr.write("KERNEL: ");
    console.error.apply(this, arguments);
};

if (process.env.DEBUG || true) {
    global["DEBUG"] = true;

    try {
        doLog = require("debug")("KERNEL:");
    } catch (err) { }
}

log = global["DEBUG"] ? doLog : dontLog;

// Setup session initialisation
config.startupCallback = async function () {
};


config.transpile = function (code) {
    // return transpile(new Error().stack.toString());
    return transpile(code);
};

// Start kernel
var kernel = new Kernel(config);

function status_busy(request) {
    request.respond(this.iopubSocket, "status", {
        execution_state: "busy"
    });
}

function status_idle(request) {
    request.respond(this.iopubSocket, "status", {
        execution_state: "idle"
    });
}

kernel.handlers.execute_request = function (request) {
    var displayIds = {};
    console.log(request);

    const self = {
        onSuccess: onSuccess.bind(this),
        onError: onError.bind(this),
        beforeRun: beforeRun.bind(this),
        afterRun: afterRun.bind(this),
        onStdout: onStdout.bind(this),
        onStderr: onStderr.bind(this),
        onDisplay: onDisplay.bind(this),
        onRequest: onRequest.bind(this),
    }


    function submit() {
        self.beforeRun();

        const hpccComms = require("@hpcc-js/comms");

        hpccComms.Workunit.submit({ baseUrl: "https://play.hpccsystems.com:18010/", rejectUnauthorized: false }, "hthor", request.content.code).then(wu => {
            return wu.watchUntilComplete();
        }).then(wu => {
            if (wu.State === "completed") {
                return wu.fetchResults().then(results => {
                    return Promise.all(results.map(r => {
                        r.fetchRows()
                            .then(rows => {
                                self.onStdout(`${r.Name}:  ${JSON.stringify(rows, undefined, 2)}\n`);
                            });
                    }));
                }).then(results => {
                    self.onSuccess(request);
                    return wu;
                });
            } else {
                return wu.fetchECLExceptions().then(exceptions => {
                    self.onStderr(JSON.stringify(exceptions, undefined, 2));
                    self.onError({
                        error: {
                            ename: "ECl Exception(s)",
                            evalue: "42",
                            traceback: "traceback"
                        }
                    });
                    return wu;
                });
            }
        }).then(wu => {
            wu.delete();
            self.afterRun();
        }).catch(e => {
            self.onStderr(e);
            self.onError(request);
            self.afterRun();
        });
    }
    submit();

    function beforeRun() {
        log("beforeRun");

        status_busy.call(this, request);

        this.executionCount++;

        request.respond(
            this.iopubSocket,
            "execute_input", {
            execution_count: this.executionCount,
            code: request.content.code,
        });
    }

    function afterRun() {
        status_idle.call(this, request);
    }

    function onSuccess(result) {
        request.respond(
            this.shellSocket,
            "execute_reply", {
            status: "ok",
            execution_count: this.executionCount,
            payload: [], // TODO(NR) not implemented,
            user_expressions: {}, // TODO(NR) not implemented,
        });

        if (!result.mime) {
            return;
        }

        if (this.hideExecutionResult) {
            return;
        }

        if (this.hideUndefined &&
            result.mime["text/plain"] === "undefined") {
            return;
        }

        request.respond(
            this.iopubSocket,
            "execute_result", {
            execution_count: this.executionCount,
            data: result.mime,
            metadata: {},
        });
    }

    function onError(result: { error: { ename: string, evalue: string, traceback: string } }) {
        request.respond(
            this.shellSocket,
            "execute_reply", {
            status: "error",
            execution_count: this.executionCount,
            ename: result.error.ename,
            evalue: result.error.evalue,
            traceback: result.error.traceback,
        });

        request.respond(
            this.iopubSocket,
            "error", {
            execution_count: this.executionCount,
            ename: result.error.ename,
            evalue: result.error.evalue,
            traceback: result.error.traceback,
        });
    }

    function onStdout(data) {
        request.respond(
            this.iopubSocket,
            "stream", {
            name: "stdout",
            text: data.toString(),
        });
    }

    function onStderr(data) {
        request.respond(
            this.iopubSocket,
            "stream", {
            name: "stderr",
            text: data.toString(),
        });
    }

    function onDisplay(update) {
        var content = {
            data: update.mime,
            metadata: {},
            transient: {}
        };

        // first call to onDisplay with a display_id sends a display_data
        // subsequent calls send an update_display_data
        var msg_type = "display_data";
        if (update.hasOwnProperty("display_id")) {
            if (displayIds.hasOwnProperty(update.display_id)) {
                msg_type = "update_display_data";
            } else {
                displayIds[update.display_id] = true;
            }

            content.transient = {
                display_id: update.display_id,
            };
        }

        request.respond(this.iopubSocket, msg_type, content);
    }

    function onRequest(message, onReply) {
        if (!message) {
            log("REQUEST: Empty request");
            return;
        }

        if (message.clear) {
            var clearOutput = request.respond(
                this.iopubSocket, "clear_output", message.clear
            );

            log("REQUEST: CLEAR_OUTPUT:", clearOutput);
            return;
        }

        if (typeof onReply !== "function") {
            log("REQUEST: Missing onReply callback");
            return;
        }

        if (message && message.input) {
            if (!request.content.allow_stdin) {
                log("REQUEST: STDIN: Frontend does not support stdin requests");
                onReply(new Error("Frontend does not support stdin requests"));
                return;
            }

            var response = request.respond(
                this.stdinSocket, "input_request", message.input
            );

            log("REQUEST: STDIN:", response);
            this.onReplies[response.header.msg_id] = onReply;
            this.lastActiveOnReply = onReply;
        }
    }
}

kernel.handlers.is_complete_request = function is_complete_request(request) {
    request.respond(this.iopubSocket, "status", {
        execution_state: "busy"
    });

    var content;
    try {
        // new vm.Script(kernel.session.transpile(request.content.code));
        content = {
            status: "complete",
        };
    } catch (err) {
        content = {
            status: "incomplete",
            indent: "",
        };
    }

    request.respond(
        this.shellSocket,
        "is_complete_reply",
        content,
        {},
        this.protocolVersion
    );

    request.respond(this.iopubSocket, "status", {
        execution_state: "idle"
    });
};

// Interpret a SIGINT signal as a request to interrupt the kernel
process.on("SIGINT", function () {
    log("Interrupting kernel");
    kernel.restart(); // TODO(NR) Implement kernel interruption
});

/**
 * Parse command arguments
 *
 * @returns {module:jp-kernel~Config} Kernel config
 */
function parseCommandArguments() {
    var config: KernelConfig = {
        cwd: process.cwd(),
        hideUndefined: true,
        protocolVersion: "5.1",
    };

    var usage = (
        "Usage: node kernel.js " +
        "[--debug] " +
        "[--hide-undefined] " +
        "[--protocol=Major[.minor[.patch]]] " +
        "[--session-working-dir=path] " +
        "[--show-undefined] " +
        "[--startup-script=path] " +
        "connection_file"
    );

    var FLAGS = [
        ["--debug", function () {
            config.debug = true;
        }],
        ["--hide-undefined", function () {
            config.hideUndefined = true;
        }],
        ["--protocol=", function (setting) {
            config.protocolVersion = setting;
        }],
        ["--session-working-dir=", function (setting) {
            config.cwd = setting;
        }],
        ["--show-undefined", function () {
            config.hideUndefined = false;
        }],
        ["--startup-script=", function (setting) {
            config.startupScript = setting;
        }],
    ];

    try {
        var connectionFile;

        process.argv.slice(2).forEach(function (arg: string) {
            for (var i = 0; i < FLAGS.length; i++) {
                var flag = FLAGS[i];
                var label = flag[0] as string;
                var action = flag[1] as (settings) => void;

                var matchesFlag = (arg.indexOf(label) === 0);
                if (matchesFlag) {
                    var setting = arg.slice(label.length);
                    action(setting);
                    return;
                }
            }

            if (connectionFile) {
                throw new Error("Error: too many arguments");
            }

            connectionFile = arg;
        });

        if (!connectionFile) {
            throw new Error("Error: missing connection_file");
        }

        config.connection = JSON.parse(fs.readFileSync(connectionFile));

    } catch (e) {
        console.error("KERNEL: ARGV:", process.argv);
        console.error(usage);
        throw e;
    }

    var nodeVersion;
    var protocolVersion;
    var jpVersion;
    var majorVersion = parseInt(config.protocolVersion.split(".")[0]);
    if (majorVersion <= 4) {
        nodeVersion = process.versions.node.split(".")
            .map(function (v) {
                return parseInt(v, 10);
            });
        protocolVersion = config.protocolVersion.split(".")
            .map(function (v) {
                return parseInt(v, 10);
            });
        config.kernelInfoReply = {
            "language": "javascript",
            "language_version": nodeVersion,
            "protocol_version": protocolVersion,
        };
    } else {
        nodeVersion = process.versions.node;
        protocolVersion = config.protocolVersion;
        var packageJsonPath = path.join(__dirname, "..", "package.json");
        jpVersion = JSON.parse(fs.readFileSync(packageJsonPath)).version;
        config.kernelInfoReply = {
            "protocol_version": protocolVersion,
            "implementation": "jp-ecl",
            "implementation_version": jpVersion,
            "language_info": {
                "name": "javascript",
                "version": nodeVersion,
                "mimetype": "application/javascript",
                "file_extension": ".js",
            },
            "banner": (
                "jp-ecl v" + jpVersion + "\n" +
                "https://github.com/GordonSmith/jp-ecl\n"
            ),
            "help_links": [{
                "text": "jp-ecl Homepage",
                "url": "https://github.com/GordonSmith/jp-ecl",
            }],
        };
    }

    return config;
}
