var net = require('net');
var fs = require('fs');
var sys = require('sys');
//var crypto = require('crypto');
var StompFrame = require('./frame').StompFrame;
var StompFrameEmitter = require('./parser').StompFrameEmitter;

var WebSocket = require('ws');

// var privateKey = fs.readFileSync('CA/newkeyopen.pem', 'ascii');
// var certificate = fs.readFileSync('CA/newcert.pem', 'ascii');
// var certificateAuthority = fs.readFileSync('CA/demoCA/private/cakey.pem', 'ascii');
// var credentials = crypto.createCredentials({
//     key: privateKey,
//     cert: certificate,
//     ca: certificateAuthority,
// });

var StompClientCommands = [
    'CONNECT',
    'SEND',
    'SUBSCRIBE',
    'UNSUBSCRIBE',
    'BEGIN',
    'COMMIT',
    'ACK',
    'ABORT',
    'DISCONNECT',
];

function StompSubscription(ws, session, ack, id) {
    this.ack = ack;
    this.session = session;
    this.ws = ws;
    this.id = id;
};

StompSubscription.prototype.send = function(stompFrame) {
    stompFrame.send(this.ws);
};

function StompQueueManager({queueMap = {}} = {}) {
    this.queues = {};
    this.msgId = 0;
    this.sessionId = 0;
    this.map = queueMap;
};

StompQueueManager.prototype.generateMessageId = function() {
    return this.msgId++;
};

StompQueueManager.prototype.generateSessionId = function() {
    return this.sessionId++;
}

StompQueueManager.prototype.subscribe = function(queue, ws, session, ack, id) {
    if (!(queue in this.queues)) {
        this.queues[queue] = [];
    }
    this.queues[queue].push(new StompSubscription(ws, session, ack, id));
};

StompQueueManager.prototype.publish = function(queue, message) {
  var receiveQueues = this.map[queue].path || [queue];
  if (receiveQueues.indexOf(queue) === -1) {
    receiveQueues.push(queue);
  }
  var noReceiveFlag = true;
  if (this.map[queue]) {
    message = JSON.parse(message);
    message = Object.assign({}, message, this.map[queue].message);
    message = JSON.stringify(message);
  }
  var msg = new StompFrame({
     command: 'MESSAGE',
     headers: {
         'message-id': this.generateMessageId()
     },
     body: message,
  });

  receiveQueues.forEach(q => {
    var subs = this.queues[q];
    if (subs && subs.length) {
      noReceiveFlag = false;
      subs.forEach(function(subscription) {
        msg.headers.subscription = subscription.id;
        msg.headers.destination = q;
        subscription.send(msg);
      })
    }
  })
  if (noReceiveFlag) {
      throw new StompFrame({
          command: 'ERROR',
          headers: {
              message: 'Queue does not exist',
          },
          body: 'Queue "' + 'queue' + '" does not exist',
      });
  }
};

StompQueueManager.prototype.unsubscribe = function(queue, session) {
    if (!(queue in this.queues)) {
        throw new StompFrame({
            command: 'ERROR',
            headers: {
                message: 'Queue does not exist',
            },
            body: 'Queue "' + frame.headers.destination + '" does not exist',
        });
    }
    // TODO: Profile this
    this.queues[queue] = this.queues[queue].filter(function(subscription) {
        return (subscription.session != session);
    });
};

function StompStreamHandler(ws, queueManager) {
    var frameEmitter = new StompFrameEmitter(StompClientCommands);
    var authenticated = false;
    var sessionId = -1;
    var subscriptions = [];
    var transactions = {};

    ws.on('message', function (data) {
        frameEmitter.handleData(data);
    });

    ws.on('close', function () {
        subscriptions.map(function(queue) {
            queueManager.unsubscribe(queue, sessionId);
        });
        //stream.end();
    });

    frameEmitter.on('frame', function(frame) {
        console.log('Received Frame: ' + frame);
        if (!authenticated && frame.command != 'CONNECT') {
            new StompFrame({
                command: 'ERROR',
                headers: {
                    message: 'Not connected',
                },
                body: 'You must first issue a CONNECT command',
            }).send(ws);
            return;
        }
        if (frame.command != 'CONNECT' && 'receipt' in frame.headers) {
            new StompFrame({
                command: 'RECEIPT',
                headers: {
                    'receipt-id': frame.headers.receipt,
                },
            }).send(ws);
        }
        try {
            switch (frame.command) {
                case 'CONNECT':
                    // TODO: Actual authentication
                    authenticated = true;
                    sessionId = queueManager.generateSessionId();
                    new StompFrame({
                        command: 'CONNECTED',
                        headers: {
                            session: sessionId,
                        }
                    }).send(ws);
                    break;

                case 'SUBSCRIBE':
                    queueManager.subscribe(frame.headers.destination,
                                            ws, sessionId,
                                            frame.headers.ack || "auto", frame.headers['id']);
                    subscriptions.push(frame.headers.destination);
                    break;

                case 'UNSUBSCRIBE':
                    queueManager.unsubscribe(frame.headers.destination, sessionId);
                    break;

                case 'SEND':
                    queueManager.publish(frame.headers.destination, frame.body);
                    break;

                case 'BEGIN':
                    if (frame.headers.transaction in transactions) {
                        throw new StompFrame({
                            command: 'ERROR',
                            headers: {
                                message: 'Transaction already exists',
                            },
                            body: 'Transaction "' + frame.headers.transaction + '" already exists',
                        });
                    }
                    transactions[frame.headers.transaction] = [];
                    break;

                case 'COMMIT':
                    // TODO: Actually apply the transaction, this is just an abort
                    delete transactions[frame.headers.transaction]
                    break;

                case 'ABORT':
                    delete transactions[frame.headers.transaction]
                    break;

                case 'DISCONECT':
                    subscriptions.map(function(queue) {
                        queueManager.unsubscribe(queue, sessionId);
                    });
                    ws.close();
                    break;
            }
        }
        catch (e) {
            e.send(ws);
        }
    });

    frameEmitter.on('error', function(err) {
        var response = new StompFrame();
        response.setCommand('ERROR');
        response.setHeader('message', err['message']);
        if ('details' in err) {
            response.appendToBody(err['details']);
        }
        response.send(ws);
    });
};

function StompServer({port=8125, queueMap={}}={}) {
    this.port = port;
    var queueManager = new StompQueueManager({
      queueMap
    });
    var wss = new WebSocket.Server({port});
    wss.on('connection', function(ws) {
      console.log('Received Unsecured Connection');
      new StompStreamHandler(ws, queueManager);
    })
}

function SecureStompServer(port, credentials) {
    StompServer.call(this);
    var queueManager = new StompQueueManager();
    this.port = port;
    this.server = net.createServer(function (stream) {
        stream.on('connect', function () {
            console.log('Received Connection, securing');
            stream.setSecure(credentials);
        });
        stream.on('secure', function () {
            new StompStreamHandler(stream, queueManager);
        });
    });
}

//sys.inherits(SecureStompServer, StompServer);

StompServer.prototype.listen = function() {
    this.server.listen(this.port, 'localhost');
};

StompServer.prototype.stop = function(port) {
    this.server.close();
};

//new SecureStompServer(8124, credentials).listen();
new StompServer({
  port: 8125,
  queueMap: {
    '/req/match/ready': {
      path: ['/req/match/ready', '/user/queue/match/ready'],
      message: {ready: 'ok'}
    }
  }
});
