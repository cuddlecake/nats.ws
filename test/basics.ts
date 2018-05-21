import {NatsWsProxy} from './helpers/nats-wsproxy'
import {NatsConnection} from "../src/nats";
import test from "ava";
import nuid from 'nuid';
import {Msg} from "../src/protocol";
import {WSTransport} from "../src/transport";
import {Lock} from "./helpers/latch";
import {startServer, stopServer} from "./helpers/nats_server_control";

let WSPORT = 56389;
let PORT = 47573;

test.before((t) => {
    return new Promise((resolve, reject) => {
        startServer(PORT)
            .then((server) => {
                t.log('server started');
                let wse = new NatsWsProxy(WSPORT, `localhost:${PORT}`);
                t.context = {wse: wse, server: server};
                resolve();
            })
            .catch((err) => {
                reject(err);
            });
    });
});

test.after.always((t) => {
    //@ts-ignore
    t.context.wse.shutdown();
    //@ts-ignore
    stopServer(t.context.server);
});


test('connect', async (t) => {
    t.plan(1);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    nc.close();
    t.pass();
});

test('fail connect', async (t) => {
    t.plan(1);
    try {
        let nc = await NatsConnection.connect({url: `ws://localhost:32001`});
        nc.close();
        t.fail();
    } catch (err) {
        t.pass();
    }
});

test('publish', async (t) => {
    t.plan(1);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    nc.publish('foo', '');
    await nc.flush();
    nc.close();
    t.pass();
});

test('subscribe and unsubscribe', async (t) => {
    t.plan(10);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let subject = nuid.next();
    let sub = await nc.subscribe(subject, () => {
    }, {max: 1000, queueGroup: 'aaa'});
    t.is(sub.sid, 1);
    t.is(nc.protocol.subscriptions.length, 1);
    let s = nc.protocol.subscriptions.get(1);
    if (s) {
        t.is(s.received, 0);
        t.is(s.subject, subject);
        t.truthy(s.callback);
        t.is(s.max, 1000);
        t.is(s.queueGroup, 'aaa');
    }
    // change the expected max
    sub.unsubscribe(10);
    t.is(nc.protocol.subscriptions.length, 1);
    s = nc.protocol.subscriptions.get(1);
    if (s) {
        t.is(s.max, 10);
    }
    // unsub
    sub.unsubscribe(0);
    t.is(nc.protocol.subscriptions.length, 0);
    nc.close();
});

test('subscriptions fire callbacks', async t => {
    t.plan(2);
    let lock = new Lock();
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let s = nuid.next();
    let sub = await nc.subscribe(s, (msg: Msg) => {
        t.pass();
        lock.unlock();
    });
    await nc.flush();
    nc.publish(s);
    await lock.latch;
    let sd = nc.protocol.subscriptions.get(1);
    if (sd) {
        t.is(sd.received, 1);
    }
    sub.unsubscribe();
    nc.close();
});


test('subscriptions pass exact subjects to cb', async (t) => {
    t.plan(1);
    let lock = new Lock();
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let s = nuid.next();
    let subj = `${s}.foo.bar.baz`;
    let sub = await nc.subscribe(`${s}.*.*.*`, (msg: Msg) => {
        t.is(msg.subject, subj);
        lock.unlock();
    });

    nc.publish(subj);
    await lock.latch;
    sub.unsubscribe();
    nc.close();
});

test('subscriptions returns Subscription', async (t) => {
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let subj = nuid.next();
    let sub = await nc.subscribe(subj, () => {
    });
    t.is(sub.sid, 1);
    sub.unsubscribe();
    nc.close();
});


test('wildcard subscriptions', async (t) => {
    t.plan(3);
    let single = 3;
    let partial = 2;
    let full = 5;

    let singleCounter = 0;
    let partialCounter = 0;
    let fullCounter = 0;

    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});

    let s = nuid.next();
    let singleSub = await nc.subscribe(`${s}.*`, () => {
        singleCounter++;
    });
    let partialSub = await nc.subscribe(`${s}.foo.bar.*`, () => {
        partialCounter++;
    });
    let fullSub = await nc.subscribe(`${s}.foo.>`, () => {
        fullCounter++;
    });

    nc.publish(`${s}.bar`);
    nc.publish(`${s}.baz`);
    nc.publish(`${s}.foo.bar.1`);
    nc.publish(`${s}.foo.bar.2`);
    nc.publish(`${s}.foo.baz.3`);
    nc.publish(`${s}.foo.baz.foo`);
    nc.publish(`${s}.foo.baz`);
    nc.publish(`${s}.foo`);

    await nc.flush();
    t.is(singleCounter, single);
    t.is(partialCounter, partial);
    t.is(fullCounter, full);

    singleSub.unsubscribe();
    partialSub.unsubscribe();
    fullSub.unsubscribe();
    nc.close();

});


test('correct data in message', async (t) => {
    t.plan(3);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let subj = nuid.next();

    let lock = new Lock();
    let sub = await nc.subscribe(subj, (m) => {
        t.is(m.subject, subj);
        t.is(m.data, '0xFEEDFACE');
        t.is(m.reply, undefined);
        lock.unlock();
    }, {max: 1});

    nc.publish(subj, '0xFEEDFACE');
    await lock.latch;
    sub.unsubscribe();
    nc.close();
});

test('correct reply in message', async (t) => {
    t.plan(2);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let s = nuid.next();
    let r = nuid.next();

    let lock = new Lock();
    let sub = await nc.subscribe(s, (m) => {
        t.is(m.subject, s);
        t.is(m.reply, r);
        lock.unlock();
    }, {max: 1});

    nc.publish(s, '', r);
    await lock.latch;
    sub.unsubscribe();
    nc.close();
});

test('closed cannot subscribe', async (t) => {
    t.plan(1);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    nc.close();
    try {
        await nc.subscribe('foo', () => {
        })
    } catch (err) {
        t.pass();
    }
});

test('close cannot request', async (t) => {
    t.plan(1);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    nc.close();
    try {
        await nc.request('foo');
    } catch (err) {
        t.pass();
    }
});

test('flush calls callback', async (t) => {
    t.plan(1);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let lock = new Lock();
    let p = nc.flush(() => {
        t.pass();
        lock.unlock();
    });

    if (p) {
        t.fail('should have not returned a promise');
    }

    await lock.latch;
    nc.close();
});

test('flush without callback returns promise', async (t) => {
    t.plan(1);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let p = nc.flush();
    if (!p) {
        t.fail('should have returned a promise');
    }
    await p;
    t.pass();
    nc.close();
});


test('unsubscribe after close', async (t) => {
    t.plan(1);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let sub = await nc.subscribe(nuid.next(), () => {
    });
    nc.close();
    sub.unsubscribe();
    t.pass();
});

test('unsubscribe stops messages', async (t) => {
    t.plan(1);
    let received = 0;
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let subj = nuid.next();
    let sub = await nc.subscribe(subj, () => {
        received++;
        sub.unsubscribe();
    });
    nc.publish(subj);
    nc.publish(subj);
    nc.publish(subj);
    nc.publish(subj);

    await nc.flush();
    t.is(received, 1);
    sub.unsubscribe();
    nc.close();
});


test('request', async t => {
    t.plan(1);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let s = nuid.next();
    let sub = await nc.subscribe(s, (msg: Msg) => {
        if (msg.reply) {
            nc.publish(msg.reply, "foo");
        }
    });
    let msg = await nc.request(s, 1000, "test");
    t.is(msg.data, "foo");
    sub.unsubscribe();
    nc.close();
});

test('request timeout', async t => {
    t.plan(1);
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    let s = nuid.next();
    try {
        await nc.request(s, 100, "test");
    } catch (err) {
        t.pass();
        nc.close();
    }
});


test('close listener is called', async (t) => {
    t.plan(1);
    let lock = new Lock();
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    nc.addEventListener('close', () => {
        t.pass();
        lock.unlock();
    });

    let stream = (nc.protocol.transport as WSTransport).stream;
    if (stream) {
        stream.close();
    }
    await lock.latch;
});

test('error listener is called', async (t) => {
    t.plan(1);
    let lock = new Lock();
    let nc = await NatsConnection.connect({url: `ws://localhost:${WSPORT}`});
    nc.addEventListener('error', () => {
        t.pass();
        lock.unlock();
    });

    // make the server angry
    (nc.protocol.transport as WSTransport).write('HelloWorld');
    await lock.latch;
});

