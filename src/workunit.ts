export function transpile(ecl: string): string {
    return `\
function submit() {
    const hpccComms = require("@hpcc-js/comms");

    hpccComms.Workunit.submit({ baseUrl: "https://play.hpccsystems.com:18010/", rejectUnauthorized: false }, "hthor", \`${ecl}\`).then(wu => {
        return wu.watchUntilComplete();
    }).then(wu => {
        if(wu.State === "completed") {
            return wu.fetchResults().then(results => {
                return Promise.all(results.map(r => {
                    r.fetchRows()
                        .then(rows => {
                            console.log(r.Name + ":", rows);
                        });
                }));
            }).then(results => {
                return wu;
            });
        } else {
            return wu.fetchECLExceptions().then(exceptions => {
                console.error(exceptions);
                return wu;
            });
        }
    }).then(wu => {
        wu.delete();
    }).catch(e=>{
        console.error(e);
    });
}

submit();
`;

    return `/
    const hpccComms = require("@hpcc-js/comms");

    export function submit(ecl) {
        let wu;
        return Workunit.submit({ baseUrl: "https://play.hpccsystems.com:18010/" }, "hthor", ecl).then(_wu => {
            wu = _wu;
            return wu.watchUntilComplete();
        }).then((wu) => {
            return wu.fetchResults().then((results) => {
                return results[0].fetchRows();
            }).then((rows) => {
                return rows;
            });
        }).then(rows => {
            wu.delete()
            console.log(rows);
        }).catch(e=>{
            console.error(rows);
        });
    }
    
    return submit(${ecl});
`;
}

import { Workunit } from "@hpcc-js/comms";

export function submit(ecl: string): Promise<object> {
    let wu;
    return Workunit.submit({ baseUrl: "https://play.hpccsystems.com:18010/" }, "hthor", ecl).then(_wu => {
        wu = _wu;
        return wu.watchUntilComplete();
    }).then((wu) => {
        return wu.fetchResults().then((results) => {
            return results[0].fetchRows();
        }).then((rows) => {
            return rows;
        });
    }).then(rows => {
        wu.delete()
        return rows;
    });
}
