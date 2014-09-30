var stun = require('vs-stun');
var crypto = require('crypto'),
    shasum = crypto.createHash('sha1');
var clj_fuzzy = require('clj-fuzzy');
var socket, server = {
        host: 'stun.l.google.com',
        port: 19302
    }

var myPeerID = "";
var peers = [];
var data = {};

function createConnection(cb) {
    var callback = function callback(error, value) {
        if (!error) {
            socket = value;
            cb();
        } else console.log('Something went wrong: ' + error);
    }

    stun.connect(server, callback);
}

createConnection(function () {
    console.log("Connection to STUN complete");
    console.log("Connection Address: " + socket.stun.public.host);
    console.log("Connection Port: " + socket.stun.public.port);
    myPeerID = getSHA(socket.stun.public.host + "p" + socket.stun.public.port);
    console.log("My Peer ID: " + myPeerID);
    //Start keepalive with stun
    setInterval(keepAlive, 10000);
    createMessageListener();
    onConnectionComplete();
});

function onConnectionComplete() {

}

function keepAlive() {
    stun.resolve(socket, server, function () {});
    //Send keep alive packet to all of our current peers
    for (var i = 0; i < peers.length; i++){
        sendPIN(peers[i].split("p")[0], peers[i].split("p")[1]);  
        //If client has less than max peers ask our peers to give us there closest matching pair
        if (peers.length < MAX_PEERS){
            sendREQ(peers[i].split("p")[0], peers[i].split("p")[1]);
        }        
    }
    
}

function connectToClient(host, port, count) {
    if (count === undefined) {
        count = 0;
    }
    setTimeout(function () {
        if (inPeerList(host, port) == false) {
            if (count < 5) {
                sendAWK(host, port);
                connectToClient(host, port, count + 1);
            } else {
                console.log("Aborted connection attempt to peer at " + host + ":" + port);
            }
        }
    }, 1000);
}

function getSHA(string) {
    shasum = crypto.createHash('sha1');
    shasum.update(string);
    return shasum.digest('hex');
}

function inPeerList(host, port) {
    if (peers.indexOf(host + "p" + port) < 0) {
        return false;
    } else {
        return true;
    }
}

function sendAWK(host, port) {
    sendMessage(host, port, {
        "m": "awk"
    });
}

function sendADD(host, port, peer){
    sendMessage(host, port, {
        "m": "add",
        "peer": peer
    });
}

var peersToBeDeleted = [];

function sendPIN(host, port){
    sendMessage(host, port, {
        "m": "pin",
    });
    peersToBeDeleted.push(host + "p" + port);
    //Delete if peer doesn't response in 3 seconds
    setTimeout(function(){
        if (peersToBeDeleted.indexOf(host + "p" + port) > -1){
            //Still in list lets remove from peers
            peersToBeDeleted.splice(peersToBeDeleted.indexOf(host + "p" + port), 1);   
            peers.splice(peers.indexOf(host + "p" + port), 1);
            console.log("Removed offline peer - " + getSHA(host + "p" + port));
        }
    }, 3000);
}

function sendPON(host, port){
    sendMessage(host, port, {
        "m": "pon",
    });
}

function sendREQ(host, port){
    sendMessage(host, port, {
        "m": "req",
        "peer":  socket.stun.public.host + "p" + socket.stun.public.port
    });
}

function sendPUT(host, port, key, value){
    sendMessage(host,port,{"m":"put","key":key,"value":value,"count":0});      
}

function sendGET(host, port, key){
    sendMessage(host,port,{"m":"get","key":key,"dest":socket.stun.public.host + "p" + socket.stun.public.port});      
}

function sendMessage(host, port, message) {
   // console.log("Sent a " + message.m);
    message = new Buffer(JSON.stringify(message));
    socket.send(message, 0, message.length, port, host, function (err, bytes) {
        if (err) throw err;
        //console.log('UDP message sent to ' + host + ':' + port);
    });
}

function createMessageListener() {
    socket.on('message', function (message, remote) {
        try {
        message = JSON.parse(message);
        //console.log("Recieved a " + message.m);
        if (message.m == "awk"){
            //We discovered a peer if they are not already a peer lets send an awk back
            if (inPeerList(remote.address, remote.port) == false){
                sendAWK(remote.address, remote.port); 
                addPeer(remote.address, remote.port);
            }
        }
            
        if (message.m == "add"){
            connectToClient(message.peer.split("p")[0], message.peer.split("p")[1]);    
        }
            
        if (message.m == "put"){
            //Client wants to store a value in the datastore
            var keyHash = getSHA(message.key);
            var value = message.value;
            var key = message.key;
            var storCount = message.count;
            //Add it to our own data store (yes thats right - we store some of the data)
            //console.log("Set " + key + " = " + value);
            data[key] = value;
            if (storCount < 8){
                storCount++;
                var cDist = 0;
                var cPos = -1;
                //Loop through our peers and forward the put request to the closest peer
                for (var i = 0; i < peers.length; i++){
                    if (peers[i] != remote.address + "p" + remote.port){
                          if (getMeasure(getSHA(peers[i]), keyHash) > cDist){
                              cDist = getMeasure(getSHA(peers[i]), keyHash);
                              cPos = i;
                          }
                    }
                }
                
                if (cPos != -1){
                    sendMessage(peers[cPos].split("p")[0],peers[cPos].split("p")[1],{"m":"put","key":key,"value":value,"count":storCount});   
                }
            }
            
        }
            
        if (message.m == "get"){
            if (data[message.key] == undefined){
                //We don't have it - forward it to the closest
                var cDist = 0;
                var cPos = -1;
                //Loop through our peers and forward the put request to the closest peer
                for (var i = 0; i < peers.length; i++){
                    if (peers[i] != remote.address + "p" + remote.port && peers[i] != message.dest){
                          if (getMeasure(getSHA(peers[i]), getSHA(message.key)) > cDist){
                              cDist = getMeasure(getSHA(peers[i]), getSHA(message.key));
                              cPos = i;
                          }
                    }
                }
                
                if (cPos != -1){
                    sendMessage(peers[cPos].split("p")[0],peers[cPos].split("p")[1],{"m":"get","key":message.key,"dest":message.dest});   
                }
            } else {
                //We have the information the user wants, lets return it
                //Find the closest peer to the destination peer
                var cDist = 0;
                var cPos = -1;
                for (var i = 0; i < peers.length; i++){
                    if (getMeasure(getSHA(peers[i]),getSHA(message.dest)) > cDist){
                        cDist = getMeasure(getSHA(peers[i]),getSHA(message.dest));
                        cPos = i;
                    }
                }
                if (cPos != -1){
                    sendMessage(peers[cPos].split("p")[0],peers[cPos].split("p")[1],{"m":"dat","key":message.key, "value":data[message.key],"dest":message.dest});   
                }
            }
        }
            
        if (message.m == "dat"){
            //console.log("Recevied key: " + message.key);
            io.sockets.emit('message', {"key":message.key, "value": message.value});
            data[message.key] = message.value;
            if (message.dest != socket.stun.public.host + "p" + socket.stun.public.port){
                var cDist = 0;
                var cPos = -1;
                for (var i = 0; i < peers.length; i++){
                    if (getMeasure(getSHA(peers[i]),getSHA(message.dest)) > cDist){
                        cDist = getMeasure(getSHA(peers[i]),getSHA(message.dest));
                        cPos = i;
                    }
                }
                if (cPos != -1){
                    sendMessage(peers[cPos].split("p")[0],peers[cPos].split("p")[1],{"m":"dat","key":message.key, "value":data[message.key],"dest":message.dest});   
                }
            } else {
                //console.log("We got a message back!!!!!!!!! OMG!!!!!!!! It worked!!!!!!");   
            }
        }
            
        if (message.m == "req"){

        for (var i = 0; i < peers.length; i++){
            if (peers[i] != message.peer){
                 //console.log("Sending ADD");
                 sendADD(peers[i].split("p")[0],peers[i].split("p")[1],message.peer);
                 sendADD( message.peer.split("p")[0],message.peer.split("p")[1], peers[i]);
            }
        }

        }
            
        if (message.m == "pin"){
            sendPON(remote.address, remote.port);
        }
            
        if (message.m == "pon"){
            //Remove peer from the to be deleted list
            peersToBeDeleted.splice(peersToBeDeleted.indexOf(remote.address + "p" + remote.port), 1);
            //console.log("Peers:" + peers.length);
        }
        } catch (e){
            //console.log(e);
        }
    });
}

var MAX_PEERS = 16;

function addPeer(host, port){
    
    if (peers.length < MAX_PEERS){
        console.log("New Peer: " + getSHA(host + "p" + port));
        peers.push(host + "p" + port);
    } else {
        //We already have enough peers but lets check if they are closer than any other of our peers
        //If they are we no longer need that peer in our list and we can remove them
        var smallestMatchAmount = 0;
        var smallestMatch = -1;
        var distance = 0;
        //Loop through all the peers
        for (var i = 0; i < peers.length; i++){
             distance = getMeasure(myPeerID, getSHA(peers[i]));
            if (distance < smallestMatchAmount){
                smallestMatchAmount = distance;
                smallestMatch = i;
            }
        }
        //Check if our new peer is closer than our furthest peer
        if (getMeasure(myPeerID, getSHA(host + "p" + port)) > smallestMatchAmount){
            //New peer is closer than one of our other peers, lets remove the other peer from the list
            peers[smallestMatch] = host + "p" + port;
        }
    }
    //Lets send our new peer to the closest of our other peers
        var matchDist = 0;
        var matchDistID = -1;
        var distance = 0;
        for (var i = 0; i < peers.length; i++){
            if (peers[i] != host + "p" + port){
                distance = getMeasure(getSHA(peers[i]),getSHA(host + "p" + port));
                if (distance > matchDist){
                    matchDist = distance;
                    matchDistID = i;
                }
            }
        }
        //Tell the pair to connect to each other
        if (matchDistID != -1){
             sendADD(peers[matchDistID].split("p")[0],peers[matchDistID].split("p")[1],host + "p" + port);
             sendADD(host, port, peers[i]);
        }
}

function getMeasure(a,b){
    return 1 - clj_fuzzy.metrics.jaccard(a, b);   
}

var app = require('http').createServer(handler)
var io = require('socket.io')(app);
var fs = require('fs');

app.listen(8123);

function handler (req, res) {
  fs.readFile(__dirname + '/index.html',
  function (err, data) {
    if (err) {
      res.writeHead(500);
      return res.end('Error loading index.html');
    }

    res.writeHead(200);
    res.end(data);
  });
}


io.on('connection', function (socket) {
  socket.on('connecttopeer', function (data){
      connectToClient(data.host, data.port);   
  });
  socket.on('sendmessage', function (data){
     for (var i = 0; i < peers.length; i++){
        sendPUT(peers[i].split("p")[0],peers[i].split("p")[1],data.user, data.message);  
     }
  });
    socket.on('getmessages', function (data){
          for (var i = 0; i < peers.length; i++){
        sendGET(peers[i].split("p")[0],peers[i].split("p")[1],data.username);  
     }
    });
});


