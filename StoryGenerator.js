var events = require('events');
var util = require('util');
var StoryNode = require('StoryNode.js');

var StoryGenerator = module.exports = function(dbClient) {
    
    // Communication
    this.elasticClient = dbClient;
    this.envGenerator = null;
    
    // Game State Variables
    this.availablePowers = [];
    
    this.influence = {};
    this.glyphStates = {
        destroyer: StoryGenerator.GLYPHSTATES.UNDISCOVERED,
        protector: StoryGenerator.GLYPHSTATES.UNDISCOVERED,
        architect: StoryGenerator.GLYPHSTATES.UNDISCOVERED,
        illusionist: StoryGenerator.GLYPHSTATES.UNDISCOVERED
    };
    
    this.playerPosition = {
        x:0,
        y:0,
    };
    this.engagement; // essentially the interval between node spawns
    
    //to store story nodes and completed nodes
    // This allows us to maintain a certain number of active nodes, while also keeping track of
    // how many nodes the player has completed;
    this.nodes = [];
    this.completedNodes = []; // can change to store the nodes themselves if needed
    this.expiredNodes = 0;
    this.nodeID = 0;
    this.maxNodes = 25; // maybe?
    
    this.gameStartNode = {};
    
    this.lastNode; // the time of the last node creation
    this.lastPlayerAction;
    
    //for custom events
    this.listeners = [];
    
    // update loop
    this.immediate;
    this.lastFrame = new Date().getTime();
    
    // DEBUG - for the debug nodes
    this.gameStart = false;
};

util.inherits(StoryGenerator, events.EventEmitter);

//StoryGenerator.prototype = new events.EventEmitter();

StoryGenerator.prototype.initialize = function(envGenerator) {
    var self = this;
    this.envGenerator = envGenerator;
    
    // Add any relevant event listeners for the env generator
    
    
    this.envGenerator.addListener("gridSquareObjects", function(objectInfo) {
        // new terrain generation decreases engagement so as to increase node generation
        self.updateEngagement(-2);
        
        // Generate a node
        //console.log("Generating new story node from new environment");
        // Generate a node
        self.generateNode([], null);
    });
    
    /*
    
    this.envGenerator.addListener("objectListenerResolved", function(data) {
        self.resolveNodeListener(data.listenerID, data.nodeID);
    });
    
    */
    
    // Power / Object change events
    this.envGenerator.addListener("expireNode", function(id) {
        self.expireNode(self.nodes[id], false);
    });
    
    
    this.engagement = StoryGenerator.ENGAGEMENT.ENGAGEMENTMIN;
    this.lastNode = new Date().getTime();
    this.lastPlayerAction = new Date().getTime();
}
StoryGenerator.prototype.disconnect = function() {
    this.envGenerator.removeAllListeners("gridSquareObjects");
    //this.envGenerator.removeAllListeners("objectListenerResolved");
};

StoryGenerator.prototype.update = function() {
    // make use of setImmediate to continually call this function when there is a free execution cycle
    var self = this;
    // Debug - attach a debug node to a random object within the draw distance every 10s
    var timeStamp = new Date().getTime();
    //console.log("Time since last node: " + (timeStamp - this.lastNode));
    
    // Check node expiry
    for (var n = this.nodes.length - 1; n >= 0; n--) {
        var node = this.nodes[n];
        if (node === null)
            continue;
        
        var valid = true;
        for (var p=0; p < node.prereqs.powers.length; p++) {
            if (this.availablePowers.indexOf(node.prereqs.powers[p]) === -1 && node.prereqs.powers[p] != "any") {
                console.log("Node invalid due to missing power: " + node.prereqs.powers[p]);
                valid = false;
                break; // no need to check the other powers - this node is not valid
            }
        }
        if ((timeStamp - node.creationTime > node.lifespan && node.lifespan > 0) || !valid) {
            this.expireNode(node, true);
            continue;
        }
    }
    
    // Decrease engagement if player is not doing anything
    if (timeStamp - this.lastPlayerAction > 10000) {
        this.updateEngagement(-10);
        this.lastPlayerAction = new Date().getTime();
    }
    
    
    var interval = map_range(this.engagement, StoryGenerator.ENGAGEMENT.ENGAGEMENTMIN, StoryGenerator.ENGAGEMENT.ENGAGEMENTMAX, StoryGenerator.ENGAGEMENT.MININTERVAL, StoryGenerator.ENGAGEMENT.MAXINTERVAL);
    if (timeStamp - this.lastNode > interval) {
        // generate a new story node
        //console.log("Generating new story node at engagement level: " + this.engagement + ", after an interval of: " + interval/1000 + "s.");
        this.generateNode([], null);
        this.lastNode = new Date().getTime();
        // emit node
    }
    this.immediate = setImmediate(function() {self.update()});
}

StoryGenerator.prototype.expireNode = function(node, valid) {
    // Node is no longer valid
    // complete any failure events
    //console.log("NODE " + node.id + ", " + node.title + " IS EXPIRING ====");
    // only play / log story events if the node was interacted with in some way
    var storyLog = {
            nodeID: node.id,
            title: node.title,
            text: ""
    }
    if (node.storyLog.length > 0) {
        storyLog.text = (valid) ? "You took too long to complete this chapter." : "You became unable to complete this chapter.";
        for (var f=0; f < node.failures[node.branch].length; f++) {
            storyLog = this.performNodeEvent(node, node.failures[node.branch][f], storyLog);
            storyLog.failure = true;
        }
    }
    // delete node
    // Remove all listeners on the node on the client side
    var listenerUpdate = {};
    listenerUpdate.remove = node.getCurrentListeners();

    // remove all object listeners
    // While doing this, strip them from the event being sent to the client 
    listenerUpdate.remove.oneOf = this.spliceListenerList(listenerUpdate.remove.oneOf, node.id);
    listenerUpdate.remove.allOf = this.spliceListenerList(listenerUpdate.remove.allOf, node.id);

    // get new listeners
    listenerUpdate.add = [];

    this.emit("nodeListenerUpdate", {nodeID: node.id, remove: listenerUpdate.remove, add: listenerUpdate.add, completed: true});
    //this.nodes.splice(n, 1);
    if (storyLog.text !== "") {
        if (!storyLog.hasOwnProperty("title") || storyLog.title === undefined)
            console.log("Node: " + this.nodes[node.id].title + " has a missing storyLog title - expireNode");
        this.emit("storyLogUpdate", storyLog);
    }
    
    this.expiredNodes ++;
    this.nodes[node.id] = null;
    //console.log("STORY LOG UPDATE: " + storyLog.text);
}

StoryGenerator.prototype.playerMoved = function( newX, newY ) {
    this.playerPosition.x = newX;
    this.playerPosition.y = newY;
}

StoryGenerator.prototype.updateEngagement = function(change) {
    this.engagement = Math.min(StoryGenerator.ENGAGEMENT.ENGAGEMENTMAX, Math.max(StoryGenerator.ENGAGEMENT.ENGAGEMENTMIN, this.engagement + change));
}

StoryGenerator.prototype.updateInfluence = function(influenceChange) {
    // First determine how many are moveable
    var changeable = [];
    for (var i in this.glyphStates) {
        if (this.glyphStates[i] != StoryGenerator.GLYPHSTATES.DOMINANT && this.glyphStates[i] != StoryGenerator.GLYPHSTATES.LOCKED)
            changeable.push(i);
    }
    
    for (i in influenceChange) {
        
        if (this.glyphStates[i] != StoryGenerator.GLYPHSTATES.DOMINANT && this.glyphStates[i] != StoryGenerator.GLYPHSTATES.LOCKED) {
            if (influenceChange[i] > 0) {
                //console.log("increasing influence of glyph: " + i + " by " + influenceChange[i]);
                this.influence[i] = Math.min(((this.glyphStates[i] <= StoryGenerator.GLYPHSTATES.DISCOVERED) ? 0.24 : 1), this.influence[i] + influenceChange[i]);

                // also must check if reaching 1 - if so, change to dominant and check listeners
                if (this.influence[i] == 1) {
                    this.glyphStates[i] = StoryGenerator.GLYPHSTATES.DOMINANT;
                    this.checkNodeListener({"glyphStates":this.glyphStates});
                }
                
            } else {
                // if influence is explicitly set negative, make sure its always above 0
                this.influence[i] = Math.max(0, this.influence[i] + influenceChange[i]);
            }
        }
    } 
    // update available powers
    this.constructPowers();
    
    // emit the update
    this.emit("gameStateUpdate", {influence: this.influence});
}

StoryGenerator.prototype.constructPowers = function() {
    // Essentially go through all the glyphs and influence and entity power and update the list
    //this.availablePowers
    
    // TODO - see if powers have been lost and emit a special log update??
    var oldPowers = this.availablePowers
    
    var availablePowers = [];
    availablePowers.push(StoryNode.POWERS.D1_FIREBALL);
    availablePowers.push(StoryNode.POWERS.I1_MORPH);
    availablePowers.push(StoryNode.POWERS.P1_REBUILD);
    availablePowers.push(StoryNode.POWERS.A1_GROW);
    
    for (var g in this.influence) {
        // g = glyph name
        if (this.glyphStates[g] >= StoryGenerator.GLYPHSTATES.FREE) { // Free, Locked, or Dominant
            if (this.influence[g] >= 0.75) {
                // tier 4 power
                availablePowers.push((g === "destroyer") ? StoryNode.POWERS.D4_BLACKHOLE : 
                                     ((g === "illusionist") ? StoryNode.POWERS.I4_MULTIMORPH : 
                                      ((g === "protector") ? StoryNode.POWERS.P4_SHIELDARMY : 
                                       StoryNode.POWERS.A4_CONSOLIDATE)));
            }
            if (this.influence[g] >= 0.5) {
                // tier 3
                availablePowers.push((g === "destroyer") ? StoryNode.POWERS.D3_ANNIHILATION : 
                                     ((g === "illusionist") ? StoryNode.POWERS.I3_WARP : 
                                      ((g === "protector") ? StoryNode.POWERS.P3_REJUVENATE : 
                                       StoryNode.POWERS.A3_FERTILIZE)));
            }
            if (this.influence[g] >= 0.25) {
                // tier 3
                availablePowers.push((g === "destroyer") ? StoryNode.POWERS.D2_VOID : 
                                     ((g === "illusionist") ? StoryNode.POWERS.I2_PULL : 
                                      ((g === "protector") ? StoryNode.POWERS.P2_SHIELD : 
                                       StoryNode.POWERS.A2_DUPLICATE)));
            } 
        }
    }
    this.availablePowers = availablePowers;
}

StoryGenerator.prototype.generateNode = function(envObjs, position) {
    // For now we will return a debug node. In future nodes will be selected from the DB
    //console.log("Generating new story node");
    var self = this;
    var msg = {
        index: "anotherend-story",
        type: "Node",
        body: {
            // power pre-reqs will be handled by the code below
            from: 0,
            size: 500
        }
    };
    self.elasticClient.search(msg).then(
        function( response) {
            //console.log("Node response from DB");
            
            // Strip out nodes that need powers or glyph states we don't have
            for (var i=response.hits.hits.length - 1; i >= 0; i--) {
                var splice = false;
                // powers
                for (var p=0; p < response.hits.hits[i]._source.prerequisites.powers.length; p++) {
                    if (self.availablePowers.indexOf(response.hits.hits[i]._source.prerequisites.powers[p]) === -1 && response.hits.hits[i]._source.prerequisites.powers[p] != "any") {
                        //console.log("Node stripped - use does not have power: " + response.hits.hits[i]._source.prerequisites.powers[p])
                        splice = true;
                        break;; // no need to check the other powers - this node is not valid
                    }
                }
                if (!splice)
                    for (var g in response.hits.hits[i]._source.prerequisites.glyphStates) {
                        // discovered does not require an exact match, just that it's not undiscovered
                        if (response.hits.hits[i]._source.prerequisites.glyphStates[g] === StoryGenerator.GLYPHSTATES.DISCOVERED) {
                            if (self.glyphStates[g] === StoryGenerator.GLYPHSTATES.UNDISCOVERED) {
                                splice = true;
                                break; 
                            }
                        // every other state requires an exact match
                        } else if (self.glyphStates[g] !== response.hits.hits[i]._source.prerequisites.glyphStates[g]) {
                            splice = true;
                            break; 
                        }    
                    }
                if (splice)
                    response.hits.hits.splice(i, 1);
            }
            
            var dbNode = response.hits.hits[Math.floor(Math.random()*response.hits.hits.length)];
            // First check if node is repeated
            //console.log("checking repeat for node.. : " + dbNode._id);
            var repeated = (self.completedNodes.indexOf(dbNode._id) > -1) ? true : false;
            
            //console.log("Attempting to generate node: " + dbNode._source.name + " from valid nodes: " + response.hits.hits.length);

            // add any object information to the DB data
            dbNode._source.ID = dbNode._id;
            
            // First pick a general location to look for objects
            var nodePos = self.envGenerator.chooseLocationForStoryNode();

            // Assign any objects to the node based on its requirements
            // If requirements can't be met, abort this node and try a new one
            var preGenObjs = [];
            for (var i=0; i < dbNode._source.prerequisites.objects.length; i++) {
                if (dbNode._source.prerequisites.objects[i].position != null) {
                    preGenObjs.push(dbNode._source.prerequisites.objects[i]);
                } else {
                    var o = self.envGenerator.getObjectForStoryNode(nodePos, dbNode._source.prerequisites.objects[i]);

                    if (o === false) {
                        self.generateNode(envObjs, position); // try a new node

                        return;
                    } else {
                        envObjs.push(o);
                    }
                }
            }
            
            // Determine whether the node has a position or object
            // Pregen objects are relative to the nodePos so we use the nodePos as the position
            // If not, pick a random position within loaded distance of the player's last known gridsquare
            if (position === null && (envObjs.length === 0 || preGenObjs.length > 0)) {
                position = nodePos;
            }
            
            // Generate any objects for the node
            if (preGenObjs.length > 0) {
                self.envGenerator.nodeGenerateObjects(nodePos, preGenObjs, envObjs).then(
                    function(response) {
                        for (var n=0; n < response.objsToAdd.length; n++) {
                            envObjs.push(response.objsToAdd[n]);
                        }
                        self.finalNodeGenerate(dbNode._source, envObjs, repeated, position, response.objsToRemove);
                    }, function(error) {
                        console.log("Generating objects for a node failed");
                        return false;
                    });
                
            } else {
                self.finalNodeGenerate(dbNode._source, envObjs, repeated, position, []);
            }


        }, function( error) {
            console.log("Node Selection failed.");
            console.log(JSON.stringify(error));
            return false;
        });
}
StoryGenerator.prototype.finalNodeGenerate = function(dbNode, envObjs, repeated, position, objsToRemove) {
    var node = this.createNodeFromData(this.nodeID, dbNode, envObjs, repeated, position);
    if (this.gameStart) {
        //console.log("NODE BEING PUSHED: " + node.title);
        this.emit("nodesToPush", {nodes: [node.getClientNode()], objsToRemove: objsToRemove});

        this.checkInitialNodeState(node);
    } 
}

StoryGenerator.prototype.createDecisionNode = function(nodeID, nodeData, glyphName, position) {
    // Get pillar and glyph from envGenerator
    // We can just start incrementing from 0 becuase towers / glyph stuff is at the beginning
    var pillar = null,
        glyph = null;
    var i = 0;
    while (pillar === null || glyph === null) {
        if (this.envGenerator.GeneratedObjectsByID[i].name === glyphName + "_pillar") {
            pillar = this.envGenerator.GeneratedObjectsByID[i];
        }else if (this.envGenerator.GeneratedObjectsByID[i].name === glyphName + "_glyph") {
            glyph = this.envGenerator.GeneratedObjectsByID[i];
        }
        i++;
    }
    //console.log("Generating Decision Node with id: " + this.nodeID)
    //console.log("pillar id: " + pillar.id);
    //console.log("glyph id: " + glyph.id);
    var node = new StoryNode(nodeID, nodeData, [pillar, glyph], false, position);
    this.nodeID ++;
    this.nodes[node.id] = node;
    return node;
};

StoryGenerator.prototype.createNodeFromData = function(nodeID, nodeData, objects, repeated, position) {
    var node = new StoryNode( nodeID, nodeData, objects, repeated, position);
    this.nodeID ++;
    
    this.nodes[node.id] = node;

    // Add listeners to any objects or to the generator itself
    var listeners = node.getCurrentListeners();
    listeners.allOf = this.spliceListenerList(listeners.allOf, node.id, true);
    listeners.oneOf = this.spliceListenerList(listeners.oneOf, node.id, true);

    //console.log("Finished Generating Story Node. Total nodes: " + self.nodes.length);
    return node;
};

StoryGenerator.prototype.generateInitialStory = function() {
    console.log("Generating initial story nodes...");
    this.emit("loadingStateUpdate", {message: "Generating Story..."});
    
    // Create initial influence state of the game
    var characters = ["architect", "destroyer", "illusionist", "protector"];
    for (var i=0; i < characters.length; i++) {
        this.influence[characters[i]] = 0;   
    }
    this.constructPowers();
    var self = this;
    
    // Add the gamestart node 
    var gsmsg = {
        index: "anotherend-story",
        type: "GameStart"
    }
    self.elasticClient.search(gsmsg).then(
        function(gsResponse) {
            var gsNode = gsResponse.hits.hits[0]._source; // there should only be one node here
            gsNode.ID = gsResponse.hits.hits[0]._id;
            // Generate any objects for the node
            var envObjs = [];
            self.envGenerator.nodeGenerateObjects({x: 0, y: 0, z: 0}, gsNode.prerequisites.objects, envObjs).then(
                function(response) {
                    for (var n=0; n < response.objsToAdd.length; n++) {
                        envObjs.push(response.objsToAdd[n]);
                    }
                    self.gameStartNode = self.createNodeFromData(self.nodeID, gsNode, envObjs, false, {x:0, y:0, z:0});
                    // hack the position for the tutorial
                    self.gameStartNode.position = {x: 0, y: 0, z: 30};
                    self.gameStartNode.getCurrentListeners().oneOf[0].subject = {x: 0, y: 0, z: 30};
                    
                    // Introduction Nodes

                    var msg = {
                        index: "anotherend-story",
                        type: "IntroNode,EndNode"
                    }

                    self.elasticClient.search(msg).then(
                        function(response) {
                            for (var n=0; n < response.hits.hits.length; n++) {
                                var node = response.hits.hits[n]._source;
                                node.ID = response.hits.hits[n]._id;
                                // get center of glyph biome
                                var glyphBiome = self.envGenerator.glyphBiomes[node.glyph];

                                var introOrEndNode = self.createNodeFromData(self.nodeID, node, [], false, {x:glyphBiome.x, y:( response.hits.hits[n]._type === "IntroNode" && node.glyph != "entity") ? 0 : glyphBiome.y, z:glyphBiome.z});

                            }


                            // Decision nodes
                            // These special nodes are attached to the pillars / glyphs
                            var msg2 = {
                                index: "anotherend-story",
                                type: "DecisionNode"
                            }
                            self.elasticClient.search(msg2).then(
                                function(response2) {
                                    for (var n=0; n < response2.hits.hits.length; n++) {
                                        var node2 = response2.hits.hits[n]._source;
                                        node2.ID = response2.hits.hits[n]._id;
                                        // get center of glyph biome
                                        var glyphBiome = self.envGenerator.glyphBiomes[node2.glyph];
                                        var decisionNode = self.createDecisionNode(self.nodeID, node2, node2.glyph, {x:glyphBiome.x, y:glyphBiome.y, z:glyphBiome.z});
                                    }


                                    // End State Nodes and Power Unlock Nodes
                                    var msg3 = {
                                        index: "anotherend-story",
                                        type: "PowerUnlock",
                                        body: {
                                            // power pre-reqs will be handled by the code below
                                            from: 0,
                                            size: 15
                                        }
                                    }
                                    self.elasticClient.search(msg3).then(
                                        function(response3) {
                                            for (var n=0; n < response3.hits.hits.length; n++) {
                                                //console.log("Power unlock nodes:: " + response3.hits.hits[n]._type);
                                                var node3 = response3.hits.hits[n]._source;
                                                node3.ID = response3.hits.hits[n]._id;
                                                var powerUnlock = self.createNodeFromData(self.nodeID, node3, [], false, {x:0, y:0, z:0});
                                            }

                                            // We want to send all the initial nodes that were created during environment generation

                                            console.log("Done generating initial story.");

                                            self.emit("loadingStateUpdate", {message: "Generation Finished."});

                                            self.emit("initialGenerationFinished", {nodes: [self.gameStartNode.getClientNode()], influence: self.influence}); // any initial nodes

                                            // There are no listeners on the gameStart node, so call checkNodeAdvance to get things going
                                            var storyLog = {
                                                nodeID: self.gameStartNode.id,
                                                title: "The Beginning",
                                                text: "Your adventure began here."
                                            };
                                            storyLog = self.checkNodeAdvance(self.gameStartNode.id, null, storyLog);
                                            self.emit("storyLogUpdate", storyLog);
                                            self.nodes[self.gameStartNode.id].storyLog.push(storyLog);

                                        }, function(error3) {
                                            console.log("ERROR selecting End Node or Power Unlock node from DB");
                                        }
                                    );

                                }, function(error2) {
                                    console.log("ERROR selecting DecisionNode s from DB");
                                });

                        }, function(error) {
                           console.log("ERROR selecting IntroNode s from DB"); 
                        });
                }, function(error) {
                    console.log("Generating objects for a node failed");
                    return false;
                });
            //self.gameStartNode = self.createNodeFromData(self.nodeID, gsNode, [], false, {x:0, y:0, z:0});
            
            
        }, function(gsError) {
            console.log("Error selecting GameStart Node");
        });
    
    
};

/* 
    ================ Updates =============

*/
StoryGenerator.prototype.resolveCharacterAction = function(actionInfo) {
    if (actionInfo.subject != StoryNode.Characters.PLAYER) {
        //console.log("Glyph Action Registered");
    } else {
        //console.log("Player Action Registered");
        this.lastPlayerAction = new Date().getTime();
        // player action increases engagement
        this.updateEngagement(5);
        
        // If there are any targets, check against their listeners
        var evtsToLog = this.envGenerator.checkListeners(actionInfo);
        for (var i=0; i < evtsToLog.length; i++) {
            var storyLog = {
                nodeID: evtsToLog[i].nodeID,
                title: this.nodes[evtsToLog[i].nodeID].title,
                text: "You used " + actionInfo.power.slice(3).toUpperCase() + " on a " + evtsToLog[i].type + "."
            }
            this.resolveNodeListener(evtsToLog[i].listenerID, evtsToLog[i].nodeID, storyLog);
        }
        
        // next check against listeners stored in the generator
        this.checkNodeListener(actionInfo);
    }
    // handle any state changes
    this.resolvePower(actionInfo);
};

StoryGenerator.prototype.resolvePower = function(actionInfo) {
    // Loop through targets and resolve any object state changes
    
    var morphObjects = [];
    for (var i=0; i < actionInfo.targets.length; i++) {
        var target = actionInfo.targets[i];
        
        if (target.hasOwnProperty("newState")) {
            // fireball, annihilation, rebuild, rejuvenate
            // update the state in EnvGenerator
            this.envGenerator.updateObjectState(target.id, target.newState);
        }
        if (target.hasOwnProperty("remove") && target.remove === true) {
            // void, blackhold, consolidate
            this.envGenerator.voidObject(target.id);
        }
        if (target.hasOwnProperty("newScale")) {
            // grow, consolidate
            this.envGenerator.updateObjectScale(target.id, target.newScale);
        }
        if (target.hasOwnProperty("newPos")) {
            // duplicate, pull
            if (target.hasOwnProperty("duplicate")) {
                console.log("Duplicate received");
                this.envGenerator.duplicateObject(target.id, target.newPos, target.duplicate);
            } else {
                this.envGenerator.updateObjectPosition(target.id, target.newPos);
            }
        }
        if (target.hasOwnProperty("morph") && target.morph === true) {
            // morph, multimorph
            morphObjects.push(target);
        }
    }
    
    if (morphObjects.length > 0)
        this.envGenerator.morphObjects(morphObjects);
};

StoryGenerator.prototype.resolveNodeListener = function(listenerID, nodeID, storyLog) {
    if (this.nodes[nodeID] === null) {
        console.log("WARN: Null node in ResolveNodeListener - " + nodeID);
        return;
    }
    
    //console.log("Resolving Node Listener: " + listenerID + " for node: " + nodeID + " - " + this.nodes[nodeID].title);
    
    // If this is the first interaction, reset the expiry timer so the player has enough time to complete the node
    if (this.nodes[nodeID].branch === 0 && this.nodes[nodeID].branchPos === 0) {
        this.nodes[nodeID].creationTime = new Date().getTime();
    }
    
    // Check if this advances
    this.checkNodeAdvance(nodeID, listenerID, storyLog);
    
};

StoryGenerator.prototype.checkNodeAdvance = function(nodeID, listenerID, storyLog) {
    var node = this.nodes[nodeID];
    if (!node) {
        console.log("Node Not Found on the Server with id: " + nodeID);
        return storyLog;
    }
    if (node.checkListeners(listenerID)) {
        //console.log("Node : " + node.title + " is being advanced");
        storyLog = this.performNodeAdvance(node, storyLog);
    }
    return storyLog;
};

StoryGenerator.prototype.performNodeAdvance = function(node, storyLog) {
    // Engagement should go up again
    this.updateEngagement(10);
    // Go through resolutions, and send any updates to the client
    // N.B. do not do this if there is a branch change underway - proceed directly to listener changes
    var listenerUpdate = this.advanceNode(node, storyLog);
    if (!listenerUpdate.resolved && listenerUpdate.add.oneOf.length === 0 && listenerUpdate.add.allOf.length === 0) {
        listenerUpdate = this.advanceNode(node, listenerUpdate.storyLog);
    }
    // I left the adding in here and not within advanceNode because I need to check whether
    // listenerUpdate.add has listeners or not, and this code may splice away any listeners

    // add new listeners.... This is a lot of code.. I will optimize
    listenerUpdate.add.oneOf = this.spliceListenerList(listenerUpdate.add.oneOf, node.id, true);
    listenerUpdate.add.allOf = this.spliceListenerList(listenerUpdate.add.allOf, node.id, true);
    //console.log("emitting listener update");
    if (storyLog.text !== "") {
        storyLog.title = node.title;
        this.emit("storyLogUpdate", storyLog);
        this.nodes[node.id].storyLog.push(storyLog);
    }
    // clear text to prevent duplicate logs
    storyLog.text = "";
    //console.log("STORY LOG UPDATE: " + listenerUpdate.storyLog.text);
    // This event now only sends non-object listeners
    this.emit("nodeListenerUpdate", {nodeID: node.id, remove: listenerUpdate.remove, add: listenerUpdate.add, completed: listenerUpdate.resolved});

    // This is done below to ensure the node is still scoped for the above client update
    if (listenerUpdate.resolved) {
        // node is finished
        
        // Invalidate any identical nodes that are currently generated to make sure they aren't seen again
        // without a repeat event
        for (var i=this.nodes.length-1; i >= 0; i--) {
            // don't check null nodes, and don't invalidate the current node
            if (this.nodes[i] != null && this.nodes[i].id != node.id && this.nodes[i].dbID === node.dbID) {
                //console.log("INVALIDATING NODE: " + this.nodes[i].id)
                this.expireNode(this.nodes[i],true);
            }
        }
        
        //remove from active node list and add to completed node list
        this.completedNodes.push(node.dbID);
        listenerUpdate.storyLog.complete = true;
        listenerUpdate.storyLog.text += " %n Chapter Completed.";
        this.nodes[node.id] = null;
        //this.nodes.splice(nodeIndex, 1);
    }
    return listenerUpdate.storyLog;
}

StoryGenerator.prototype.spliceListenerList = function(listenerList, nodeID, add) {
    // add = boolean - false = remove
    for (var l=listenerList.length-1; l >=0; l--) {
        var listener = listenerList[l];
        if (listener.type === StoryNode.ListenerTypes.OBJECT) {
            var objID = listener.subject.id;
            if (add) {
                //console.log("STORY GEN: adding object listener for node: " + nodeID);
                this.envGenerator.addObjectListener(objID, nodeID, listener, this.nodes[nodeID].title);
            } else {
                //console.log("STORY GEN: removing object listener for node: " + nodeID);
                this.envGenerator.removeObjectListener(objID, nodeID, listener.id, this.nodes[nodeID].title);
            }
            listenerList.splice(l, 1);
        } else if (listener.type != StoryNode.ListenerTypes.LOCATION){
            if (add) {
                this.addNodeListener(nodeID, listener);
            } else {
                //console.log("STORY GEN: removing node listener for node: " + nodeID);
                this.removeNodeListener(nodeID, listener.id);
            }
            listenerList.splice(l, 1);
        }
    }
    return listenerList;
}

StoryGenerator.prototype.advanceNode = function(node, storyLog) {
    if (node.newBranch === null) {
        //console.log("advancing node: " + node.title + " with: " + node.getCurrentEventResolutions().length + " resolution events.");
        var resolutions = node.getCurrentEventResolutions();
        for (var r=0; r < resolutions.length; r++) {
            storyLog = this.performNodeEvent(node, resolutions[r], storyLog);
        }
    }
    // Remove all listeners on the node on the client side
    var listenerUpdate = {};
    listenerUpdate.remove = node.getCurrentListeners();
    // advance node state
    listenerUpdate.resolved = false;
    
    // Branch flag for story logging
    if (node.newBranch != null)
        storyLog.branch = true;

    if (node.advanceState()) {
        // node is resolved, add a flag to remove it after the update is sent to client
        //console.log("Node resolved: " + node.id + " - " + node.title);
        storyLog.complete = true;
        storyLog.text += " %n Chapter Completed.";
        listenerUpdate.resolved = true;
    }
    if (this.gameStartNode != null && node.id === this.gameStartNode.id && node.branchPos < 3) { // don't need to do this past the first convo hence 3
        // hack position for tutorial
        node.position = {x:0, y:0, z: -30};
        for (var r=0; r < node.getCurrentEventResolutions().length; r++) {
            var rs = node.getCurrentEventResolutions()[r];
            if (rs.hasOwnProperty("goals")) {
                rs.goals[0].position.z = -28;
                rs.goals[0].position.x += 5;
            }
        }
        if (node.branchPos > 0)
            for(var r = 0; r < node.getCurrentListeners().oneOf.length; r++) {
                var l = node.getCurrentListeners().oneOf[r];
                if (l.hasOwnProperty("actionID") && l.actionID === "distance")
                    l.subject = node.position;
            }
    }
    // get new listeners
    listenerUpdate.add = node.getCurrentListeners();
    
    // remove all object listeners and add new listeners to appropriate objects
    // While doing this, strip them from the event being sent to the client 
    listenerUpdate.remove.oneOf = this.spliceListenerList(listenerUpdate.remove.oneOf, node.id);
    listenerUpdate.remove.allOf = this.spliceListenerList(listenerUpdate.remove.allOf, node.id);
    
    listenerUpdate.storyLog = storyLog;
    
    return listenerUpdate;
};

StoryGenerator.prototype.getClientNodes = function() {
    var arr = [];
    console.log("Initializing with: " + this.nodes.length + " nodes");
    for (var i=0; i < this.nodes.length; i++) {
        if (this.nodes[i] === null)
            continue;
        
        arr.push(this.nodes[i].getClientNode());
    }
    return arr;
};

StoryGenerator.prototype.checkInitialNodeState = function(node) {
    // Check if the node should be advanced (if the initial state has no listeners)
    var storyLog ={
        nodeID: node.id,
        title: node.title,
        text: ""
    };
    if (node.id != this.gameStartNode.id) {
        storyLog = this.checkNodeAdvance(node.id, null, storyLog);
    }
    if (storyLog.text !== "") {
        if (!storyLog.hasOwnProperty("title") || storyLog.title === undefined)
            console.log("Node: " + this.nodes[node.id].title + " has a missing storyLog title - checkInitialNodeState");
        this.emit("storyLogUpdate", storyLog);
        this.nodes[node.id].storyLog.push(storyLog);
    }
};

StoryGenerator.prototype.performNodeEvent = function(node, event, storyLog) {
    var nodeID = node.id;
    switch (event.type) {
        case StoryNode.ResolutionTypes.SPEECH:
            // Character speech
            for (var i=0; i < event.conversation.length; i++) {
                if (event.conversation[i].value.substr(0,4) === "url:")
                    continue;
                storyLog.text += " %n ";
                switch(event.conversation[i].subject) {
                    case StoryNode.Characters.ARCHITECT:
                        storyLog.text += " %a ";
                        break;
                    case StoryNode.Characters.DESTROYER:
                        storyLog.text += " %d ";
                        break;
                    case StoryNode.Characters.ILLUSIONIST:
                        storyLog.text += " %i ";
                        break;
                    case StoryNode.Characters.PROTECTOR:
                        storyLog.text += " %p ";
                        break;
                    case StoryNode.Characters.ENTITY:
                        storyLog.text += " %e ";
                        break;
                }
                storyLog.text += event.conversation[i].value;
            }
            //console.log("Posting conversation for node: " + node.title);
            this.emit("characterMessage", {nodeID: nodeID, conversation: event.conversation});
            break;
        case StoryNode.ResolutionTypes.EFFECT:
            // Update the status of glyphs and / or influence
            //console.log("CHANGING: " + event.value.subject + " to state: " + event.value.value);
            var glyph = event.value.subject;
            this.glyphStates[glyph] = event.value.value;
            storyLog.special = true;
            switch(glyph) {
                case "architect":
                    storyLog.text += " %n " + glyph + " ( %a ) became ";
                    break;
                case "destroyer":
                    storyLog.text += " %n " + glyph + " ( %d ) became ";
                    break;
                case "illusionist":
                    storyLog.text += " %n " + glyph + " ( %i ) became ";
                    break;
                case "protector":
                    storyLog.text += " %n " + glyph + " ( %p ) became ";
                    break;
                case "entity":
                    storyLog.text += " %n " + glyph + " ( %e ) became ";
                    break;
            }
            switch(this.glyphStates[glyph]) {
                case StoryGenerator.GLYPHSTATES.DISCOVERED:
                    storyLog.text += "known to you.";
                    break;
                case StoryGenerator.GLYPHSTATES.LOCKED:
                    this.influence[glyph] = 0.49; // 0.49 because 0.5 allows access to tier 3 power
                    storyLog.text += "locked back to Entity.";
                    break;
                case StoryGenerator.GLYPHSTATES.FREE:
                    if (this.influence[glyph] < 0.25)
                        this.influence[glyph] = 0.25;
                    storyLog.text += "freed from Entity.";
                    break;
                case StoryGenerator.GLYPHSTATES.DOMINANT:
                    storyLog.text += "Dominant.";
                    break;
                    
            }
            
            // Send the event
            this.emit("gameStateUpdate", {character: event.subject, influence: this.influence, glyphState: this.glyphStates});
            
            // Check if this glyphstate change has triggered any other nodes
            this.checkNodeListener({glyphStates: this.glyphStates});
            break;
        case StoryNode.ResolutionTypes.INFLUENCE:
            // influence change
            this.updateInfluence(event.value);
            break;
        case StoryNode.ResolutionTypes.INTERRUPT:
            storyLog.text += " %n You interrupted their conversation.";
            this.emit("conversationInterrupt", {nodeID: nodeID});
            break;
        case StoryNode.ResolutionTypes.ESSENCE:
            this.emit("essenceGoals", {nodeID: nodeID, goals: event.goals}); // goals is an array
            break;
        case StoryNode.ResolutionTypes.GOALSINTERRUPT:
            this.emit("goalsInterrupt", {nodeID: nodeID});
            break;
        case StoryNode.ResolutionTypes.MUSIC:
            this.emit("playMusic", {filepath: event.value.filepath});
            break;
        case StoryNode.ResolutionTypes.GAMESTART:
            // send the rest of the nodes to the client, with a custom event saying start listening to nodes
            // and remove the gamestart node
            console.log("GAME SHOULD START NOW");
            // Don't nullify the game start node here - let the regular process take care of it.
            this.emit("startListeningToNodes", {nodes: this.getClientNodes()});
            
            // Begin listening for nodes
            this.gameStart = true;

            // Begin update loop
            var self = this;
            
            // Reset all created nodes time to now to prevent timeouts
            for (var i=0; i < this.nodes.length; i++) {
                if (this.nodes[i] === null)
                    continue;
                this.nodes[i].creationTime = new Date().getTime();
                
                //console.log("Checking initial state of node : " + this.nodes[i].title);
                this.checkInitialNodeState(this.nodes[i]);
            }
            
            this.immediate = setImmediate(function(){ self.update()});
            break;
        case StoryNode.ResolutionTypes.GAMEEND:
            // send the game end event
            this.emit("gameEnd", {});
            break;
    }
    return storyLog;
};

// Event Listeners
StoryGenerator.prototype.addNodeListener = function(nodeID, listener) {
    listener.nodeID = nodeID;
    this.listeners.push(listener);
};

StoryGenerator.prototype.removeNodeListener = function(nodeID, listenerID) {
    for (var i=this.listeners.length-1; i >= 0 ; i--) {
        if (this.listeners[i].id === listenerID && this.listeners[i].nodeID === nodeID)
           this.listeners.splice(i, 1); 
    }
};

StoryGenerator.prototype.checkNodeListener = function(actionInfo) {
    for (var i=0; i < this.listeners.length; i++) {
        var storyLog = {
            nodeID: this.listeners[i].nodeID,
            title: this.nodes[this.listeners[i].nodeID].title,
            text: ""
        }
        switch (this.listeners[i].type) {
            case StoryNode.ListenerTypes.POWER: // Powers use with or without target
                if (!actionInfo.hasOwnProperty("power") || actionInfo.hasOwnProperty("powerSelect"))
                    break;
                //console.log("matching power: " + actionInfo.power+ " against: " + this.listeners[i].actionID);
                if (this.listeners[i].actionID === undefined || this.listeners[i].actionID === actionInfo.power) {
                    // Resolve listener
                    //console.log("POWER LISTENER MATCH : " + actionInfo.power);
                    storyLog.text += "You used: " + actionInfo.power.slice(3).toUpperCase() + ".";
                    this.resolveNodeListener(this.listeners[i].id, this.listeners[i].nodeID, storyLog);
                }
                break;
            case StoryNode.ListenerTypes.CONVERSATIONEND: // Conversation end event
                if (!actionInfo.hasOwnProperty("nodeID") || !actionInfo.hasOwnProperty("conversation"))
                    break;
                if (this.listeners[i].nodeID === actionInfo.nodeID) {
                    // resolve
                    //console.log("CONVERSATION END LISTENER MATCH FOR NODE: " + actionInfo.nodeID)
                    this.resolveNodeListener(this.listeners[i].id, this.listeners[i].nodeID, storyLog);
                }
                break;
            case StoryNode.ListenerTypes.GOALSEND: // Essence Goals Complete
                if (!actionInfo.hasOwnProperty("nodeID") || !actionInfo.hasOwnProperty("goals"))
                    break;
                if (this.listeners[i].nodeID === actionInfo.nodeID) {
                    // resolve
                    //console.log("ESSENCE GOALS COMPLETE LISTENER MATCH FOR NODE: " + actionInfo.nodeID)
                    this.resolveNodeListener(this.listeners[i].id, this.listeners[i].nodeID, storyLog);
                }
                break;
            case StoryNode.ListenerTypes.POWERSELECT: // Power Select event
                if (!actionInfo.hasOwnProperty("powerSelect"))
                    break;
                //console.log("checking power select for: " + actionInfo.power + " against listener for: " + this.listeners[i].actionID);
                if (this.listeners[i].actionID == undefined || this.listeners[i].actionID === actionInfo.power) {
                    // Resolve
                    this.resolveNodeListener(this.listeners[i].id, this.listeners[i].nodeID, storyLog);
                }
                break;
            case StoryNode.ListenerTypes.INFLUENCE:
                // also Check that we are comparing the same character
                if (!actionInfo.hasOwnProperty("influence") || actionInfo.influence.hasOwnProperty(this.listeners[i].subject))
                    break;
                
                if (actionInfo.influence[this.listeners[i].subject] > this.listeners[i].value) {
                    // resolve
                    this.resolveNodeListener(this.listeners[i].id, this.listeners[i].nodeID, storyLog);
                }
                break;
            case StoryNode.ListenerTypes.GLYPHSTATE:
                if (!actionInfo.hasOwnProperty("glyphStates"))
                    break;
                if (actionInfo.glyphStates[this.listeners[i].subject] === this.listeners[i].value) {
                    // resolve
                    this.resolveNodeListener(this.listeners[i].id, this.listeners[i].nodeID, storyLog);
                }
                break;
        }
    }
};


// Cheat Codes
StoryGenerator.prototype.cheat = function(codes) {
    console.log("Cheat code sent: ");
    for (var i=0; i < codes.length; i++) {
        switch(codes[i]) {
            case "give_powers": {
                console.log("Setting all glyphs to Dominant and all Influence to 1");
                for (var g in this.glyphStates) {
                    this.glyphStates[g] = StoryGenerator.GLYPHSTATES.DOMINANT;
                    this.influence[g] = 1;
                }
                this.checkNodeListener({"glyphStates":{"destroyer":4,"architect":4,"illusionist":4,"protector":4}});
                this.constructPowers();
            }
        }
    }
}


/*
    =============== Utility functions ===============
*/

function map_range(value, low1, high1, low2, high2) {
    return low2 + (high2 - low2) * (value - low1) / (high1 - low1);
}

/////////////////////////////////////
//           ENUMERATORS           //
/////////////////////////////////////

StoryGenerator.GLYPHSTATES = {
    UNDISCOVERED: 0,
    DISCOVERED: 1,
    FREE: 2,
    LOCKED: 3,
    DOMINANT: 4
}

StoryGenerator.ENGAGEMENT = {
    ENGAGEMENTMIN: 0,
    ENGAGEMENTMAX: 100,
    MININTERVAL: 3300,
    MAXINTERVAL: 25000
}