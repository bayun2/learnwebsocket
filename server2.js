var WebSocketServer = require('ws').Server,
    wss = new WebSocketServer({port: 8181, handleProtocols: function(protocol, cb) {
    var v10_stomp = protocol[protocol.indexOf("v10.stomp")];
    if(v10_stomp) {
        cb(true, v10_stomp);
        return;
    }
    cb(false);
}}),
uuid = require('node-uuid'),
Stomp = require('stompjs');

var connected_sessions = [];

wss.on('connection', function(ws) {
    console.log('CONNECT received');
    var sessionid = uuid.v4();

    stocks[sessionid] = {};
    connected_sessions.push(ws);
    stocks[sessionid]['ws'] = ws;

    ws.on('message', function(message) {
        var frame = Stomp.Frame.(message);
        var headers = frame['headers'];
        switch(frame['command']) {
            case "CONNECT":
                console.log("Command received: CONNECT");

                Stomp.send_frame(ws, {
                    command: "CONNECTED",
                    headers: {
                        session: sessionid
                    },
                    content: ""
                });
                break;
            case "SUBSCRIBE":
                var subscribeSymbol = symbolFromDestination(
                                        frame['headers']['destination']);
                stocks[sessionid][subscribeSymbol] = 0;
                break;
            case "UNSUBSCRIBE":
                var unsubscribeSymbol = symbolFromDestination(
                                        frame['headers']['destination']);
                delete stocks[sessionid][unsubscribeSymbol];
                break;
            case "DISCONNECT":
                console.log("Disconnecting");
                closeSocket();
                break;
            default:
                Stomp.send_error(ws, "No valid command frame");
                break;
        }
    });

    var symbolFromDestination = function(destination) {
        return destination.substring(destination.indexOf('.') + 1,
                                        destination.length);
    };

    var closeSocket = function() {
        ws.close();
        if(stocks[sessionid] && stocks[sessionid]['ws']) {
            stocks[sessionid]['ws'] = null;
        }
        delete stocks[sessionid];
      };

    ws.on('close', function() {
        closeSocket();
    });

    process.on('SIGINT', function() {
        console.log("Closing via break");
        closeSocket();
        process.exit();
    });


});
