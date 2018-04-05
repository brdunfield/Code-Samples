var events = require('events');
var util = require('util');
var Math3D = require('Math3D.js');
var SimplexNoise = require('simplex-noise.js');

var EnvironmentGenerator = module.exports = function(dbClient) {
    this.storyGenerator = null;
    
    this.seed = new Date().getTime();
    this.simplex = new SimplexNoise();
    
    this.elasticClient = dbClient;
    this.requestQueue = [];
    this.inQueue = false;
    
    this.waitingToGenerate = [];
    
    this.cachedResponse = null;
    
    this.fertSeed = this.seed + 9;
    this.tempSeed = this.seed + 5;
    this.civSeed = this.seed - 23;
    
    this.colourSeed = parseInt(this.seed/2);
    this.palettes = [];
    
    this.Math3D = new Math3D();
    
    
    /* Generate Initial JSON chunks ( 500 x 500)
        
        1. Define glyph biomes - for now just divide along x, y axis - TODO - randomize
            - Central area is just defined by a distance
        
    */
    
    // TODO: Find a way to do this asynchronously, as the client is kept waiting on first load
    // for awhile for 100 chunks to generate
    this.GeneratedWorld = []; // terrain
    this.GeneratedObjects = []; // stored for grid pos
    this.GeneratedObjectsByID = [];
    this.NewObjects = [];
    this.lastObjID = 0;
    
    this.cancelQueue = false;
    
    this.glyphBiomes = {};
    
    this.gameStart = false;
    
    //this.generateForPosition({x:0, y:0}, []);
    console.log("Environment Generator Initialized");
    
    this.playerPosition = {
        x:0,
        y:0,
    };
};
util.inherits(EnvironmentGenerator, events.EventEmitter);
//EnvironmentGenerator.prototype = new events.EventEmitter();

EnvironmentGenerator.prototype.initialize = function(storyGenerator) {
    var self = this;
    this.storyGenerator = storyGenerator;
    // Add any relevant event listeners
    var promise = new Promise(function(resolve, reject) {
        // Select palettes from DB and categorize
        var msg = {
            index: "anotherend-palettes",
            body: {

                //this time we define a query in the body
                from: 0,
                size: 100
            }
        };
        
        self.elasticClient.search(msg).then(
            function(response) {
                // go through returned palettes
                var glyphPalettes = {};
                for (var i = 0; i < response.hits.hits.length; i++) {
                    var p = response.hits.hits[i]._source;
                    if (p.glyph === "") {
                        self.palettes[p.slice] = p;
                    } else {
                        glyphPalettes[p.glyph] = p;
                    }
                }
                resolve({glyphPalettes: glyphPalettes});
            }, function(error) {
                reject(error);
            });
    });
    return promise;
};

EnvironmentGenerator.prototype.disconnect = function() {
    // cancel any queues
    this.cancelQueue = true;
    // remove any event listeners here
};

EnvironmentGenerator.prototype.addObjectToGenerator = function(gridPos, obj) {
    this.GeneratedObjects[gridPos.x][gridPos.y].push(obj);
    this.GeneratedObjectsByID[obj.id] = obj;
};


/*

    =============== Events from Socket ================

*/

EnvironmentGenerator.prototype.playerMoved = function(newX, newY) {
    
    //console.log("Player Position update to: " + newX + ", " + newY);
    this.generateForPosition({x: newX, y: newY});
    this.playerPosition.x = newX;
    this.playerPosition.y = newY;   
};

EnvironmentGenerator.prototype.getTerrainJSON = function(pos, level) {
    return this.GeneratedWorld[pos.x][pos.y].terrain[level];    
};

EnvironmentGenerator.prototype.getObjectJSON = function(pos, level) {
    // This function returns object JSON for a client request. If the objects are not generated,
    // the request is added to the queue and will be pushed as soon as it is done.
    var self = this;
    // FallBack - if not generated yet, add a listener which will send it when it's ready
    if (this.GeneratedObjects[pos.x][pos.y].length === 0) {
        //console.log("Adding objects to queue for gridPos: [" + pos.x + "," + pos.y + "]");
        this.waitingToGenerate.push({pos: pos, level: level});
        return false;
    }
    //console.log("Returning : " + this.GeneratedObjects[pos.x][pos.y].length + " objects for gridPos: [" + pos.x + "," + pos.y + "]");
    return this.GeneratedObjects[pos.x][pos.y];
};

EnvironmentGenerator.prototype.checkListeners = function(evt) {
    //console.log("Checking object Listeners - evt has " + evt.targets.length + " targets.");
    var eventLog = [];
    for (var t=0; t < evt.targets.length; t++) {
        //console.log("Checking target with id: " + evt.targets[t].id);
        var objToCheck = evt.targets[t].id;
        var obj = this.GeneratedObjectsByID[objToCheck];
        if (!obj.hasOwnProperty("listeners")) {
            continue;
        }
        for (var l=0; l < obj.listeners.length; l++) {
           // If power enum matches listener, fire event to story generator
           //console.log("Object has a listener for action: " + obj.listeners[l].listener.actionID + " for node: " + obj.listeners[l].nodeID);
           if (obj.listeners[l].listener.actionID === "any" || evt.power === obj.listeners[l].listener.actionID) {
                eventLog.push({
                    type: ((obj.type === "Religious" || obj.type === "Human") ? "Ruin" : obj.type),
                    nodeID: obj.listeners[l].nodeID,
                    listenerID: obj.listeners[l].listener.id
                });
           }
        }
    }
    return eventLog;
};

EnvironmentGenerator.prototype.updateObjectState = function(objID, newState) {
    var obj = this.GeneratedObjectsByID[objID];
    if (obj == undefined) {
        console.log("ERROR (UpdateObjectState): Object with id: " + objID + " not found on the server.");
        return;
    }
    obj.state = newState;
    
    
    //This may not be the right place for this logic....
    if (obj.hasOwnProperty("listeners") && obj.listeners.length > 0) {
        for (var l=0; l < obj.listeners.length; l++) {
            // expire nodes that can no longer have listeners be completed
            if (obj.listeners[l].listener.subject.state != null && obj.listeners[l].listener.subject.state != newState) {
                this.emit("expireNode", obj.listeners[l].nodeID);
            }
        }
    }
    
};

EnvironmentGenerator.prototype.voidObject = function(objID) {
    // If the object has a listener / node attached, send a flag to expire that node
    var obj = this.GeneratedObjectsByID[objID];
    if (obj === undefined) {
        console.log("ERROR (voidObject): Object with id: " + objID + " not found on the server.");
        return;
    }
    if (obj.hasOwnProperty("listeners") && obj.listeners.length > 0) {
        for (var l=0; l < obj.listeners.length; l++) {
            this.emit("expireNode", obj.listeners[l].nodeID);
        }
    }
    // delete the object
    obj = null;
};

EnvironmentGenerator.prototype.updateObjectScale = function(objID, newScale) {
    var obj = this.GeneratedObjectsByID[objID];
    if (!obj || !obj.hasOwnProperty("scale")) {
        console.log("Cannot update scale on object: " + objID + ", type: " + obj.type);
        return;
    }
    obj.scale.x = newScale;
    obj.scale.y = newScale;
    obj.scale.z = newScale;
};

EnvironmentGenerator.prototype.updateObjectPosition = function(objID, newPos) {
    var obj = this.GeneratedObjectsByID[objID];
    obj.position.x = newPos.x;
    obj.position.z = newPos.z;
};

EnvironmentGenerator.prototype.duplicateObject = function(objID, newPos, tempID) {
    // get gridPos for new position
    var gridPos = {x: parseInt(newPos.x / 50), y: parseInt(newPos.z / 50)},
        objToCopy = this.GeneratedObjectsByID[objID];
    if (objToCopy === undefined) {
        console.log("ERROR (duplicateObject): Object with id: " + objID + " not found on the server.");
        return;
    }
    // copy object
    var newObj = {
        id: this.lastObjID,
        name: "DuplicatedObject", // todo - to change?
        position: {x:newPos.x , y:0, z:newPos.z },
        scale: objToCopy.scale,
        alignToTerrainHeight: true,
        alignToTerrainNormal: objToCopy.alignToTerrainNormal,
        listeners: [],
        pieces: objToCopy.pieces,
        type: objToCopy.type
    };
    
    // add to gridPos / generatedObjectsByID
    this.addObjectToGenerator(gridPos, newObj);
    
    this.lastObjID ++;
    
    this.emit("newID", {oldID: tempID, newID: newObj.id});
};

EnvironmentGenerator.prototype.morphObjects = function(targets) {
    // array of objects - query db once and assign random responses to each target
    var msg = {
        index: "anotherend-objects",
        body: {
            from: 0,
            size: 500,
            query:{
                bool: {
                    must: [{match: {BaseObject : true}}]
                }
            }
        }
    };
    var self = this
    
    var newObjs = [];
    self.elasticClient.search(msg).then(
        function( response ) 
            {
                for (var i=0; i < targets.length; i++) {
                    var oldObj = self.GeneratedObjectsByID[targets[i].id];
                    if (oldObj === undefined) {
                        console.log("ERROR (morphObjects): Object with id " + targets[i].id + " was not found on the server.");
                        return;
                    }
                    var objects = {
                        id: targets[i].id,
                        name: "MorphedObject", // todo - to change?
                        position: {x:oldObj.position.x, y:0, z:oldObj.position.z},
                        scale: {},
                        rotation: {x:0, y:Math.random()*Math.PI*2, z:0},
                        alignToTerrainHeight: true,
                        alignToTerrainNormal: false,
                        listeners: [],
                        pieces: []
                    };
                    if (oldObj.hasOwnProperty("collider"))
                        objects.collider = oldObj.collider;
                    self.createObjectFromResponse(response, objects).then(
                        function(objResponse) {
                            newObjs.push(objResponse.objects);
                            if (newObjs.length === targets.length) {
                                for (var o=0; i < newObjs.length; o++) {
                                    var gridPos = {x: Math.floor(newObjs[o].position.x / 50), y: Math.floor(newObjs[o].position.z / 50)};
                                    // add object to generatedObjects
                                    if (typeof(self.GeneratedObjects[gridPos.x]) == 'undefined') {
                                        self.GeneratedObjects[gridPos.x] = [];
                                    }
                                    if (typeof(self.GeneratedObjects[gridPos.x][gridPos.y]) == 'undefined') {
                                        self.GeneratedObjects[gridPos.x][gridPos.y] = [];
                                    }
                                    self.addObjectToGenerator(gridPos, newObjs[o]);
                                }
                                
                                self.emit("objectUpdate", newObjs);
                            }
                            resolve(objResponse);
                        }, function(error) {
                            console.log("Morph object DB FAILURE");
                            console.log(error);
                        });
                }
            },
            function(error)
            {
                reject(JSON.stringify(error));
            }
    );
};

/* 
    ================ Initial Generation =============

*/
EnvironmentGenerator.prototype.generateInitialWorld = function(glyphPalettes) {
    console.log("Generating Initial World....");
    var self = this;
    
    this.emit("loadingStateUpdate", {message: "Placing Towers..."});
    
    // Start by randomly placing the towers at a distance of 600-1000, and roughly in the 4 cardinal directions.
    // For now, we will make that tower appear at the center of its gridsquare, and there will be no other objects
    
    var towers = [],
        skies = [];
    var entityBiome = {
        x: (Math.random()*100 + 275) * ((Math.random() > 0.5) ? 1 : -1),
        z: (Math.random()*100 + 275) * ((Math.random() > 0.5) ? 1 : -1)
    };
    var EntityTower = {
        id: this.lastObjID,
        name:"entity_tower",
        alignToTerrainHeight: false,
        alignToTerrainNormal: false,
        alwaysActive: true,
        position: {x: entityBiome.x, y: 0, z: entityBiome.z},
        pieces: [
            {
                url: {0: "assets/towers/entity_tower.js" },
                color1: glyphPalettes["entity"].tower[0],
                color2: glyphPalettes["entity"].tower[1]
            }
        ],
        collider : {
            type: 2,
            radius: 100,
            url: "assets/towers/entity_collision.js"
        },
        type: "GlyphTower"
    };
    this.lastObjID ++;
    var EntityPillar = {
        id: this.lastObjID,
        name:"entity_pillar",
        alignToTerrainHeight: false,
        alignToTerrainNormal: false,
        alwaysActive: true,
        position: {x: entityBiome.x, y: 0, z: entityBiome.z},
        pieces: [
            {
                url: {0: "assets/towers/entity_pillar.js" },
                color1: glyphPalettes["entity"].tower[0],
                color2: glyphPalettes["entity"].tower[1]
            }
        ],
        type: "GlyphPillar"
    };
    this.lastObjID ++;
    var EntityGlyph = {
        id: this.lastObjID,
        name:"entity_glyph",
        alignToTerrainHeight: false,
        alignToTerrainNormal: false,
        alwaysActive: true,
        position: {x: entityBiome.x, y: 40, z: entityBiome.z},
        pieces: [
            {
                url: {0: "assets/glyphs/entity_glyph.js" },
                color1: glyphPalettes["entity"].essence,
                color2: [ 0.371, 0.371, 0.371]
            }
        ],
        type: "Glyph"
    };
    this.lastObjID ++;
    this.GeneratedObjects[0] = [];
    this.GeneratedObjects[0][-1] = [EntityTower, EntityPillar, EntityGlyph];
    this.GeneratedObjectsByID[EntityTower.id] = EntityTower;
    this.GeneratedObjectsByID[EntityPillar.id] = EntityPillar;
    this.GeneratedObjectsByID[EntityGlyph.id] = EntityGlyph;

    towers.push(EntityTower);
    towers.push(EntityPillar);
    towers.push(EntityGlyph);
    var radius = Math.random()*100 + 300;
    this.glyphBiomes["entity"] = {
        x: entityBiome.x,
        y: 37,
        z: entityBiome.z,
        radius: radius,
        palette: glyphPalettes["entity"]
    };
    //entity sky
    var randEntity = Math.floor(Math.random()*glyphPalettes["entity"].skies.length);
    var sky = glyphPalettes["entity"].skies[randEntity];
    sky.position = EntityTower.position;
    sky.radius = radius;
    skies.push(sky);
    // default sky
    glyphPalettes["entity"].skies.splice(randEntity, 1);
    randEntity = Math.floor(Math.random()*glyphPalettes["entity"].skies.length);
    sky = glyphPalettes["entity"].skies[randEntity];
    sky.position = null;
    sky.radius = 300;
    skies.push(sky);
    
    var towerNames = {"destroyer": 9, "illusionist": 8, "protector": 6, "architect": 6};
    for (var glyphName in towerNames) {
        // find an acceptable distance that is >600m from any other tower
        var towerPos = {x: 0, y: 0};
        var foundSpot = false,
            attempts =0;
        placementLoop:
        while(foundSpot === false) {
            attempts ++;
            if (attempts > 50) { // If I get this, I need to rethink the algorithm
                console.log("Tower not placed.. no suitable location found");
                break;
            }
            
            towerPos.x = (Math.round(Math.random()*300) + 550) * ((Math.random() < 0.5) ? 1 : -1) + entityBiome.x;
            towerPos.y = (Math.round(Math.random()*300) + 550) * ((Math.random() < 0.5) ? 1 : -1) + entityBiome.z;
            
            var spotFound = true;
            for (var t=0; t < towers.length; t++) {
                var dist = distance(towerPos.x, towerPos.y, towers[t].position.x, towers[t].position.z);
                //console.log("Distance: " + dist);
                if (dist < 700 || distance(towerPos.x, towerPos.y, 0,0) < 450) {
                    //console.log("failed attempt to place tower");
                    spotfound = false;
                    continue placementLoop;
                }
            }
            foundSpot = true;
        }
        var rotation = {x: 0, y: Math.random()*Math.PI*2, z: 0};
        var y = (glyphName === "destroyer") ? 8.5 : 0;
        var tower = {
            id: this.lastObjID,
            name: glyphName + "_tower",
            alignToTerrainHeight: false,
            alignToTerrainNormal: false,
            alwaysActive: true,
            position: {x: towerPos.x, y: 0, z: towerPos.y},
            rotation: rotation,
            pieces: [
                {
                    url: {0: "assets/towers/" + glyphName + "_tower.js"},
                    color1: glyphPalettes[glyphName].tower[0],
                    color2: glyphPalettes[glyphName].tower[1]
                }
            ],
            collider : {
                type: 2,
                radius: 100,
                url: "assets/towers/" + glyphName + "_tower_collision.js"
            },
            type: "GlyphTower"
        };
        towers.push(tower);
        this.lastObjID ++;
        var pillar = {
            id: this.lastObjID,
            name: glyphName + "_pillar",
            alignToTerrainHeight: false,
            alignToTerrainNormal: false,
            alwaysActive: true,
            position: {x: towerPos.x, y: 0, z: towerPos.y},
            rotation: rotation,
            pieces: [
                {
                    url: {0: "assets/towers/" + glyphName + "_pillar.js"},
                    color1: glyphPalettes[glyphName].tower[0],
                    color2: glyphPalettes[glyphName].tower[1]
                }
            ],
            type: "GlyphPillar"
        };
        towers.push(pillar);
        this.lastObjID ++;
        var glyph = {
            id: this.lastObjID,
            name: glyphName + "_glyph",
            alignToTerrainHeight: false,
            alignToTerrainNormal: false,
            alwaysActive: true,
            position: {x: towerPos.x, y: towerNames[glyphName], z: towerPos.y},
            rotation: rotation,
            pieces: [
                {
                    url: {0: "assets/glyphs/" + glyphName + "_glyph.js"},
                    color1: glyphPalettes[glyphName].essence,
                    color2: [ 1, 1, 1]
                }
            ],
            type: "Glyph"
        };
        towers.push(glyph);
        this.lastObjID ++;
        
        
        // find gridsquare and set value
        var gridSquare = {x: Math.ceil(towerPos.x/50), y: Math.ceil(towerPos.y/50)};
        console.log("Tower placed after " + attempts + " attempts at [" + towerPos.x + ", " + towerPos.y + "], gridSquare: [" + gridSquare.x + ", " + gridSquare.y + "]");
        this.GeneratedObjects[gridSquare.x] = [];
        this.GeneratedObjects[gridSquare.x][gridSquare.y] = [tower, pillar, glyph];
        this.GeneratedObjectsByID[tower.id] = tower;
        this.GeneratedObjectsByID[pillar.id] = pillar;
        this.GeneratedObjectsByID[glyph.id] = glyph;
        var biomeRadius = Math.random()*100 + 400;
        this.glyphBiomes[glyphName] = {
            x: towerPos.x,
            y: y,
            z: towerPos.y,
            radius: biomeRadius,
            palette: glyphPalettes[glyphName]
        };
        var randSky = Math.floor(Math.random()*glyphPalettes[glyphName].skies.length);
        sky = glyphPalettes[glyphName].skies[randSky];
        sky.position = tower.position;
        sky.radius = biomeRadius;
        skies.push(sky);
    }

    
    this.generateForPosition({x:0, y:0}).then(
        function(response) {
            console.log("Done Generating Initial world");
            self.emit("initialGenerationFinished", { objects: towers, skies: skies});
        }, function(error) {
            
        });
};


/*
    =============== Terrain Algorithm ===============
*/


EnvironmentGenerator.prototype.generateTerrainJSON = function(gridPos, level) {
    // chunks are 50 metres square
    // Input:  The grid position of the chunk being generated, and the world seed for the current session
    // Output: a JSON String containing the terrain mesh JSON for the chunk
    //console.log("Generating chunk at grid x: " + gridPos.x + ", y: " + gridPos.y + " at level: " + level);
    var JSONobj = {};
    JSONobj.metadata = {};
    JSONobj.scale = 1;
    JSONobj.materials = [	{
        "DbgColor" : 15658734,
        "DbgIndex" : 0,
        "DbgName" : "default",
        "vertexColors" : true
        }];
    JSONobj.vertices = [];
    JSONobj.faces = [];
    JSONobj.normals = [];
    JSONobj.colors = [];
    JSONobj.uvs = [[]];
    
    var xstart = gridPos.x * 50;
    var ystart = gridPos.y * 50;
    
    // determine density of polygon stepping here
    // N.B. Stepping needs to be evenly divisble by 50 to make sure chunks line up
    var step;
    switch (level) {
        case 0:
            step = 10;
            break;
        case 1:
            step = 5;
            break;
            
    }
    // vertices
    for (var y = ystart; y < 51 + ystart; y+= step) {
        //var array = (vtx.vtxs[y] !== undefined) ? vtx.vtxs[y] : [];
        for (var x = xstart; x < 51 + xstart; x+= step) {
            var normx = x/51, // normalize to the chunk size
                normy = y/51,
                value = null;
            
            //add noise to the vertex position
            var noiseX = 0, noiseY = 0, noiseZ = 0;
            //low poly terrain gets no variance
            if( level >= 1 )
            {
                var posVariance = (level < 1) ? 0 : 5;
                var heightVariance = 1;
                noiseX = map_range(this.simplex.noise3D( 3*normx, 3*normy, this.seed + 05 ), 0, 1, -posVariance, posVariance);
                //remove height noise to make the terrain smoother in the game
                noiseY = 0;//map_range(this.simplex.noise3D( 3*normx, 3*normy, this.seed + 10 ), 0, 1, -heightVariance, heightVariance);
                noiseZ = map_range(this.simplex.noise3D( 3*normx, 3*normy, this.seed + 15 ), 0, 1, -posVariance, posVariance);
                
                //move based on normal
                var normal = this.getTerrainNormal(x + noiseX, y + noiseZ);
                var nsAmount = this.simplex.noise3D( 100*normx, 100*normy, this.seed + 08 )*2 - 1;
                noiseX += -normal.x * nsAmount;
                noiseY += -normal.y * nsAmount;
                noiseZ += -normal.z * nsAmount;
            }

            //First check if we are near enough to a tower that we need to override the noise map
            var glyphBiome = null;
            for (var i in this.glyphBiomes) {
                var distToTower = distance(x + noiseX, y + noiseZ, this.glyphBiomes[i].x, this.glyphBiomes[i].z)
                if (distToTower < 150) {
                    glyphBiome = i;
                    // if distance < 75, completely flat. If 75 - 150, gradient between flat and natural
                    if (distToTower < 75) {
                        value = 0;
                    } else {
                        // proportional average between 0 and noise height
                        var val1 = 0,
                            val2 = this.getNoiseHeight(normx + noiseX/51, normy + noiseZ/51);
                        var proportion = map_range(distToTower, 75, 150, 1, 0);
                        value = (val1*proportion) + (val2*(1-proportion));
                    }
                    break;
                }
            }
            // now check if we are near the start - same thing
            if (Math.abs(x + noiseX) < 101 && Math.abs(y + noiseZ) < 101) {
                var distToOrigin = distance(x + noiseX, y + noiseZ, 0, 0);
                if (distToOrigin < 100) {
                    // if distance < 30, completely flat. If 30-100, gradient between flat and natural
                    if (distToOrigin < 30) {
                        value = 0;
                    } else {
                        // proportional average between 0 and noise height
                        var val1 = 0,
                            val2 = this.getNoiseHeight(normx + noiseX/51, normy + noiseZ/51);
                        var proportion = map_range(distToOrigin, 30, 100, 1, 0);
                        value = (val1*proportion) + (val2*(1-proportion));
                    }
                }
            }
            if (value === null) {
                value = this.getNoiseHeight(normx + noiseX/51, normy + noiseZ/51);
            }

            // Push to String
            JSONobj.vertices.push(x - xstart + noiseX);
            JSONobj.vertices.push(value + noiseY);
            JSONobj.vertices.push(y - ystart + noiseZ);
        }
        //vtx.vtxs.push(array);
    }
    
    // faces
    var faceStep = Math.ceil(51/step);
    var colorsIndex = 0;
    var colors = (level >= 1) ? 'all' : 'average';
    var colorAverage = [ 0, 0, 0 ];
    var faceCount = 0;
    
    for (var y=0; y < (faceStep - 1) * faceStep;  y+= faceStep) {
        for (var x=0; x < faceStep - 1; x ++) {
            // determine where the face is in the world and colour appropriately
            var xcoord = JSONobj.vertices[(x+y)*3] + xstart;//xstart + x;
            var ycoord = JSONobj.vertices[(x+y)*3 + 2] + ystart;//ystart + y;
            
            // Get colour for face
            
            // First, define saturation based on temperature = 0 = 0, 1 = 100
            var saturation = this.simplex.noise3D( 0.003*xcoord, 0.003*ycoord, this.tempSeed);
            // For secondary blending
            var fertilityBlend = this.simplex.noise3D( 0.003*xcoord, 0.003*ycoord, this.fertSeed),
                civBlend = this.simplex.noise3D( 0.003*xcoord, 0.003*ycoord, this.civSeed);
            
            var colorFace = null; // the final colour
            
            // First check if within a glyph biome
            var glyphBiome = this.getGlyphBiome({x:xcoord, y:ycoord});
            if (glyphBiome != null) {
                var palette,
                    colorBlend;
                palette = this.glyphBiomes[glyphBiome].palette;
                var col1Default = HSVtoRGB(palette.default[0]/360,palette.default[1]/100*saturation, palette.default[2]/100),
                    col1Fert = HSVtoRGB(palette.fertility[0]/360,palette.fertility[1]/100*saturation, palette.fertility[2]/100),
                    col1Civ = HSVtoRGB(palette.civilization[0]/360,palette.civilization[1]/100*saturation, palette.civilization[2]/100);
                // Blend the fert and civ with the default for the final colour
                colorBlend = [
                    (col1Default[0] + (col1Fert[0]*fertilityBlend) + (col1Civ[0]*civBlend)) / (1 + fertilityBlend + civBlend),
                    (col1Default[1] + (col1Fert[1]*fertilityBlend) + (col1Civ[1]*civBlend)) / (1 + fertilityBlend + civBlend),
                    (col1Default[2] + (col1Fert[2]*fertilityBlend) + (col1Civ[2]*civBlend)) / (1 + fertilityBlend + civBlend)
                ];
                // Now check if we are at the borders, so we can blend with the regular colour
                var borderDist = distance(xcoord, ycoord, this.glyphBiomes[glyphBiome].x, this.glyphBiomes[glyphBiome].z)/this.glyphBiomes[glyphBiome].radius;
                if (borderDist > 0.9) {
                    borderDist = map_range(borderDist, 0.9, 1, 1, 0); // proportion
                    // blend with colourWheel colour appropriately
                    var colWheel = this.getColourWheelBlend(xcoord, ycoord, saturation, fertilityBlend, civBlend);
                    colorFace = [
                        ((colorBlend[0]*borderDist) + (colWheel[0]*(1-borderDist))),
                        ((colorBlend[1]*borderDist) + (colWheel[1]*(1-borderDist))),
                        ((colorBlend[2]*borderDist) + (colWheel[2]*(1-borderDist))),
                    ];
                } else {
                    colorFace = colorBlend;
                }

            } else {
                colorFace = this.getColourWheelBlend(xcoord, ycoord, saturation, fertilityBlend, civBlend);
            }
            
            if(colors === 'all')
            {
                var colorVariance = 0.05;

                //put some noise on the color for each triangle
                var colorNoise = -1 + 2 * Math.random();
                colorNoise *= colorVariance;

                //add color to object
                JSONobj.colors.push( Math.min( Math.max( colorFace[0] + colorNoise, 0 ), 1) );
                JSONobj.colors.push( Math.min( Math.max( colorFace[1] + colorNoise, 0 ), 1) );
                JSONobj.colors.push( Math.min( Math.max( colorFace[2] + colorNoise, 0 ), 1) );
            }
            
            //console.log("Selected Color: " + color);
            // Push the two faces to make up the quad... TODO make it an actual quad?
            // Face Bit Type - Triangle with vertex colors
            JSONobj.faces.push(128);
            // Vertex Indices
            JSONobj.faces.push(x+y);
            JSONobj.faces.push(x+y+faceStep);
            JSONobj.faces.push(x+y+1);
            // Vertex Color Indices
            JSONobj.faces.push(colorsIndex);
            JSONobj.faces.push(colorsIndex);
            JSONobj.faces.push(colorsIndex);
            
            faceCount++;
            
            if(colors === 'all')
            {
                colorsIndex ++;

                //put some noise on the color for each triangle
                var colorNoise = -1 + 2 * Math.random();
                colorNoise *= colorVariance;

                //add color to object
                JSONobj.colors.push( Math.min( Math.max( colorFace[0] + colorNoise, 0 ), 1) );
                JSONobj.colors.push( Math.min( Math.max( colorFace[1] + colorNoise, 0 ), 1) );
                JSONobj.colors.push( Math.min( Math.max( colorFace[2] + colorNoise, 0 ), 1) );
            }
            
            // Face Bit Type - Triangle with vertex colors
            JSONobj.faces.push(128);
            // Vertex Indices
            JSONobj.faces.push(x+y+faceStep);
            JSONobj.faces.push(x+y+faceStep + 1);
            JSONobj.faces.push(x+y+1);
            // Vertex Color Indices
            JSONobj.faces.push(colorsIndex);
            JSONobj.faces.push(colorsIndex);
            JSONobj.faces.push(colorsIndex);
            
            faceCount++;
            
            if(colors === 'all')
            {
                colorsIndex ++;
            }
            
            //this could just be an else but I find it reads better
            else if(colors === 'average')
            {
                colorAverage[0] += colorFace[0];
                colorAverage[1] += colorFace[1];
                colorAverage[2] += colorFace[2];
            }
        }
    }
    if(colors === 'average')
    {
        colorAverage[0] /= faceCount;
        colorAverage[1] /= faceCount;
        colorAverage[2] /= faceCount;
        
        JSONobj.colors.push( colorAverage[0] );
        JSONobj.colors.push( colorAverage[1] );
        JSONobj.colors.push( colorAverage[2] );
    }
    
    //console.log(JSONobj.colors.length + ", " + JSONobj.faces.length);

    var JSONstring = JSON.stringify(JSONobj);
    //console.log(JSONobj);
    //console.log(JSONstring);
    return JSONstring;

}

//takes position in GRID UNITS and returns the height of the world
EnvironmentGenerator.prototype.getNoiseHeight = function(xVal, yVal) 
{
    // Size variable controls "zoom" of noise map - it is itself noise mapped to create more dynamic terrain
    var size = map_range(this.simplex.noise3D( 0.03 * xVal, 0.03 * yVal, this.seed - 17 ), 0, 1, 0.005, 0.20),
        value;

    // Create a smaller-scale noisemap for more jagged terrain
    var smoothness = map_range(this.simplex.noise3D( 0.4 * xVal, 0.4 * yVal, this.seed + 1 ), 0, 1, 0, 1),
        variance = map_range(this.simplex.noise3D( 1.2 * xVal, 1.2 * yVal, this.seed - 82 ), 0, 1, -5, 5);
    
    value = map_range(this.simplex.noise3D( size*xVal, size*yVal, this.seed ), 0, 1, -80, 50) + (variance * smoothness);
    return value;
}

//takes position in METERS and returns the normal of the terrain relative to the global "up y" vector
EnvironmentGenerator.prototype.getTerrainNormal = function(x, y)
{
    //get three vectors on terrain
    var vec1 = {x: x, y: 0, z:y},
        vec2 = {x: x+0.5, y: 0, z:y},
        vec3 = {x: x, y: 0, z:y+0.5};
    
    //get height values for them
    vec1.y = this.getNoiseHeight( vec1.x / 51, vec1.z / 51 );
    vec2.y = this.getNoiseHeight( vec2.x / 51, vec2.z / 51 );
    vec3.y = this.getNoiseHeight( vec3.x / 51, vec3.z / 51 );
    
    //turn vertices into edges
    var edge1 = {
        x: vec2.x - vec1.x,
        y: vec2.y - vec1.y,
        z: vec2.z - vec1.z
    };
    var edge2 = {
        x: vec3.x - vec1.x,
        y: vec3.y - vec1.y,
        z: vec3.z - vec1.z
    };
    
    //normal is cross product of the two edges
    var normal = {
        x: edge1.y * edge2.z - edge1.z * edge2.y,
        y: edge1.z * edge2.x - edge1.x * edge2.z,
        z: edge1.x * edge2.y - edge1.y * edge2.x
    };
    
    //normalize
    var mag = Math.sqrt( normal.x * normal.x + normal.y * normal.y + normal.z * normal.z );
    normal.x /= mag;
    normal.y /= mag;
    normal.z /= mag;
    
    return normal;
}

//takes position in METERS and returns the angle of the terrain relative to the global "up y" vector
EnvironmentGenerator.prototype.getTerrainAngle = function(x, y)
{
    // For some reason, removing the below code and calling this.getTerrainNormal causes an error..
    //get three vectors on terrain
    var vec1 = {x: x, y: 0, z:y},
        vec2 = {x: x+0.5, y: 0, z:y},
        vec3 = {x: x, y: 0, z:y+0.5};
    
    //get height values for them
    vec1.y = this.getNoiseHeight( vec1.x / 51, vec1.z / 51 );
    vec2.y = this.getNoiseHeight( vec2.x / 51, vec2.z / 51 );
    vec3.y = this.getNoiseHeight( vec3.x / 51, vec3.z / 51 );
    
    //turn vertices into edges
    var edge1 = {
        x: vec2.x - vec1.x,
        y: vec2.y - vec1.y,
        z: vec2.z - vec1.z
    };
    var edge2 = {
        x: vec3.x - vec1.x,
        y: vec3.y - vec1.y,
        z: vec3.z - vec1.z
    };
    
    //normal is cross product of the two edges
    var normal = {
        x: edge1.y * edge2.z - edge1.z * edge2.y,
        y: edge1.z * edge2.x - edge1.x * edge2.z,
        z: edge1.x * edge2.y - edge1.y * edge2.x
    };
    
    //find angle between normal and UP
    //cosAngle = (a dot b) / (magA * magB)
    var aDotB = normal.x * 0 + normal.y * 1 + normal.z * 0,
        magA = Math.sqrt( edge1.x * edge1.x + edge1.y * edge1.y + edge1.z * edge1.z ),
        magB = Math.sqrt( edge2.x * edge2.x + edge2.y * edge2.y + edge2.z * edge2.z )
    var theta = Math.acos(aDotB / (magA * magB));
    
    theta = (0.5 * Math.PI) - (theta % (0.5 * Math.PI));
    
    return theta;
}

EnvironmentGenerator.prototype.getColourWheelBlend = function(xcoord, ycoord, saturation, fertilityBlend, civBlend) {
    // Get the "Biome" colour from the colour simplex noise map, and map to a degree position on the colour wheel
    var colourWheel = map_range(this.simplex.noise3D( 0.0005*xcoord, 0.0005*ycoord, this.colourSeed), 0, 1, 0, 360);
    var colours = this.palettes;
    var sliceSize = 360 / colours.length;
    var slice = Math.floor(colourWheel / sliceSize);
    // convert to RGB
    var col1Default = HSVtoRGB(colours[slice].default[0]/360,colours[slice].default[1]/100*saturation, colours[slice].default[2]/100),
        col1Fert = HSVtoRGB(colours[slice].fertility[0]/360,colours[slice].default[1]/100*saturation, colours[slice].fertility[2]/100),
        col1Civ = HSVtoRGB(colours[slice].civilization[0]/360,colours[slice].default[1]/100*saturation, colours[slice].civilization[2]/100);
    // Blend the fert and civ with the default for the final colour
    var col1 = [
        (col1Default[0] + (col1Fert[0]*fertilityBlend) + (col1Civ[0]*civBlend)) / (1 + fertilityBlend + civBlend),
        (col1Default[1] + (col1Fert[1]*fertilityBlend) + (col1Civ[1]*civBlend)) / (1 + fertilityBlend + civBlend),
        (col1Default[2] + (col1Fert[2]*fertilityBlend) + (col1Civ[2]*civBlend)) / (1 + fertilityBlend + civBlend)
    ];


    // Check if near border, if so blend

    var blendSlice,
        proportion;
    if ((colourWheel % sliceSize) / sliceSize < 0.2) {
        // for now do 50%
        var blendSlice = (slice === 0) ? colours.length -1 : slice - 1;
        var col2Default = HSVtoRGB(colours[blendSlice].default[0]/360,colours[blendSlice].default[1]/100*saturation, colours[blendSlice].default[2]/100),
            col2Fert = HSVtoRGB(colours[blendSlice].fertility[0]/360,colours[blendSlice].default[1]/100*saturation, colours[blendSlice].fertility[2]/100),
            col2Civ = HSVtoRGB(colours[blendSlice].civilization[0]/360,colours[blendSlice].default[1]/100*saturation, colours[blendSlice].civilization[2]/100);
        var col2 = [
            (col2Default[0] + (col2Fert[0]*fertilityBlend) + (col2Civ[0]*civBlend)) / (1 + fertilityBlend + civBlend),
            (col2Default[1] + (col2Fert[1]*fertilityBlend) + (col2Civ[1]*civBlend)) / (1 + fertilityBlend + civBlend),
            (col2Default[2] + (col2Fert[2]*fertilityBlend) + (col2Civ[2]*civBlend)) / (1 + fertilityBlend + civBlend)
        ];
        // convert to RGB
        var proportion = map_range(((colourWheel % sliceSize) / sliceSize), 0, 0.2, 0.5, 1);
        colorFace = [
            ((col1[0]*proportion) + (col2[0]*(1-proportion))),
            ((col1[1]*proportion) + (col2[1]*(1-proportion))),
            ((col1[2]*proportion) + (col2[2]*(1-proportion))),
        ];

    } else if ((colourWheel % sliceSize) / sliceSize > 0.8) {
        var blendSlice = (slice === colours.length-1) ? 0 : slice + 1;
        var col2Default = HSVtoRGB(colours[blendSlice].default[0]/360,colours[blendSlice].default[1]/100*saturation, colours[blendSlice].default[2]/100),
            col2Fert = HSVtoRGB(colours[blendSlice].fertility[0]/360,colours[blendSlice].default[1]/100*saturation, colours[blendSlice].fertility[2]/100),
            col2Civ = HSVtoRGB(colours[blendSlice].civilization[0]/360,colours[blendSlice].default[1]/100*saturation, colours[blendSlice].civilization[2]/100);
        var col2 = [
            (col2Default[0] + (col2Fert[0]*fertilityBlend) + (col2Civ[0]*civBlend)) / (1 + fertilityBlend + civBlend),
            (col2Default[1] + (col2Fert[1]*fertilityBlend) + (col2Civ[1]*civBlend)) / (1 + fertilityBlend + civBlend),
            (col2Default[2] + (col2Fert[2]*fertilityBlend) + (col2Civ[2]*civBlend)) / (1 + fertilityBlend + civBlend)
        ];
        var proportion = map_range(((colourWheel % sliceSize) / sliceSize), 0.8, 1, 1, 0.5);
        colorFace = [
            ((col1[0]*proportion) + (col2[0]*(1-proportion))),
            ((col1[1]*proportion) + (col2[1]*(1-proportion))),
            ((col1[2]*proportion) + (col2[2]*(1-proportion))),
        ];
    } else {
        // no blending required, use original colour
        colorFace = col1;
    }
    
    return colorFace;
}

EnvironmentGenerator.prototype.generateForPosition = function(pos) {
    var self=this;
    //console.log("Generating For Position: [" + pos.x + ", " + pos.y + "]");
    var promise = new Promise(function(resolve, reject) {
        self.generateTerrainForPosition(pos);
        self.generateObjectsForPosition(pos).then(
            function(response) {
                resolve({generationFinished:true});
            }, function(error) {
                console.log("Erroring out at generateForPosition");
                console.log("ERROR: " + JSON.stringify(error));
            });
        });
    return promise;
}
EnvironmentGenerator.prototype.generateTerrainForPosition = function(pos) {
    if (!this.gameStart) {
        this.emit("loadingStateUpdate", {message: "Generating Terrain..."});
        console.log("Generating Terrain...");
    }
    for (var x = pos.x - 10; x <= pos.x + 10; x++) {
        if (typeof(this.GeneratedWorld[x]) == 'undefined') {
            this.GeneratedWorld[x] = [];
        }
        for (var y = pos.y - 10; y <= pos.y + 10; y++) {
            // if it's already been generated, don't generate it again - copy over from the last known GeneratedWorld
            // Todo: See if there's a neater way to do this.. this is pretty quick n dirty
            if (typeof(this.GeneratedWorld[x][y]) == 'undefined') {
                this.GeneratedWorld[x][y] = new WorldPiece({x: x, y:y});
                // Store different levels of terrain as an array in the terrain object, so it does not need to be regenerated whenever the player moves
                this.GeneratedWorld[x][y].terrain = [];
                this.GeneratedWorld[x][y].terrain[0] = this.generateTerrainJSON({x: x, y: y}, 0);
                this.GeneratedWorld[x][y].terrain[1] = this.generateTerrainJSON({x: x, y: y}, 1);
            } else {
                if (this.GeneratedWorld[x][y].terrain != null) {
                    this.GeneratedWorld[x][y].terrain = this.GeneratedWorld[x][y].terrain;
                } else {
                    this.GeneratedWorld[x][y].terrain[0] = this.generateTerrainJSON({x: x, y: y}, 0);
                    this.GeneratedWorld[x][y].terrain[1] = this.generateTerrainJSON({x: x, y: y}, 1);                    
                }
            }
        }
    }
    if (!this.gameStart)
        console.log("Done Generating Terrain");
}
EnvironmentGenerator.prototype.generateObjectsForPosition = function(pos) {
    var self = this;
    var promisesSent = 0,
        promisesReceived = 0;
    if (!this.gameStart) {
        console.log("Generating Objects...");
        this.emit("loadingStateUpdate", {message: "Generating Objects..."});
    }
    var promise = new Promise(function(resolve, reject) {
        for (var x = pos.x - 6; x <= pos.x + 6; x++) {
            if (typeof(self.GeneratedObjects[x]) == 'undefined') {
                self.GeneratedObjects[x] = [];
            }
            if (typeof(self.NewObjects[x]) == 'undefined') {
                self.NewObjects[x] = [];
            }
            for (var y = pos.y - 6; y <= pos.y + 6; y++) {
                // if it's already been generated, don't generate it again - copy over from the last known GeneratedWorld
                // Todo: See if there's a neater way to do this.. this is pretty quick n dirty
                if (typeof(self.GeneratedObjects[x][y]) == 'undefined') {

                    self.GeneratedObjects[x][y] = [];
                    if (typeof(self.NewObjects[x][y]) == 'undefined')
                        self.NewObjects[x][y] = [];
                    
                    self.generateObjectsForSquare({x:x, y:y});
                }
            }
        }
        // run the queue - when its done, the world is done generating
        //console.log("Firing Queue.");
        if (!self.inQueue) { // avoid running the queue when it's already running
            self.runObjectQueue().then(
                function(response) {
                    // Add new objects to GeneratedObjects, and send NewObjects to client
                    if (!self.gameStart)
                        console.log("Done Generating Objects");
                    for (x in self.NewObjects) {
                        for (y in self.NewObjects[x]) {
                            self.GeneratedObjects[x][y] = self.NewObjects[x][y];
                            // Store by ID as well
                            for (var i=0; i < self.NewObjects[x][y].length; i++)
                                self.GeneratedObjectsByID[self.NewObjects[x][y][i].id] = self.NewObjects[x][y][i];
                            
                            // fire a gridSquareObjects event with a random object to increase story node gen
                            if (self.NewObjects[x][y].length > 0) {
                                var tries = 0;
                                var object = self.NewObjects[x][y][Math.round(Math.random()*(self.NewObjects[x][y].length - 1))];
                                self.emit("gridSquareObjects", object);
                            }
                            
                            // Check if the client is waiting on this chunk and send it if so
                            for (var i = (self.waitingToGenerate.length - 1); i >= 0; i--) {
                                var chunk = self.waitingToGenerate[i];
                                if (x === chunk.pos.x && y === chunk.pos.y) {
                                    //console.log("Outstanding objects sent for gridPos: [" + x + "," + y + "]");
                                    self.emit("outstandingObjectRequest", {gridPosition: chunk.pos, level: chunk.level, objects: self.GeneratedObjects[x][y]});
                                    self.waitingToGenerate.splice(i, 1);
                                }
                            }
                        }
                    }
                    resolve({GeneratedObjects: self.NewObjects});
                    self.NewObjects = [];
                }, function(error) {
                    console.log("RequestQueue Fire Error");
                    reject(error);
                });
        }
    });
    return promise;
}

var WorldPiece = function(pos)
{
    this.position = pos;
    //this.level = World.levels.NONE;
    
    this.terrain = null;
    
    this.objects = [];
};


/*

    ================== Objects ==================

*/
EnvironmentGenerator.prototype.generateObjectsForSquare = function(gridPos) {
    //console.log("Generating for Square: [" + gridPos.x + "," + gridPos.y +"]");
    var self = this;
    var objects = [];
    var objectFileName = "";

    var rand;

    var promisesSent = 0,
        promisesFulfilled = 0;
    
    //return; // DEBUG to speed things up
    // don't generate in the first 4 gridsquares
    if (gridPos.x === -1 || gridPos.x === 0)
        if (gridPos.y === -1 || gridPos.y === 0)
            return;
    
    //console.log("Generating objects for gridSquare: " + gridPos.x + ", " + gridPos.y);
    for (var x=0; x < 50; x+=(Math.random()*10 + 7)) {
        for (var y=0; y < 50; y +=(Math.random()*10 + 7)) {
            // First, check if we are close to a tower - don't generate objects within towers
            var generate = true;
            for (var i in this.glyphBiomes) {
                if (distance((x + (50*gridPos.x)), (y + (50*gridPos.y)), this.glyphBiomes[i].x, this.glyphBiomes[i].z) < 60)
                    generate = false;
            }
            // Next query the terrain slope - if it is too great, don't generate
            if (this.getTerrainAngle(x + (50*gridPos.x), y + (50*gridPos.y)) > Math.PI/5) {
                generate = false;
            }


            /*
                Generating Vegetation

                The fertility value of the terrain will influence whether or not vegetation is generated.
                The higher the fertility, the more likely to spawn an object

            */
            if (generate) {
                var fertility = self.simplex.noise3D( 0.003*(x + (50*gridPos.x)), 0.003*(y + (50*gridPos.y)), self.fertSeed), // (0 to 1)
                    temperature = self.simplex.noise3D( 0.003*(x + (50*gridPos.x)), 0.003*(y + (50*gridPos.y)), self.tempSeed),
                    civilization = self.simplex.noise3D( 0.003*(x + (50*gridPos.x)), 0.003*(y + (50*gridPos.y)), self.civSeed);


                // Calculate an overall spawn item chance based on the factors above
                // higher fert / higher civ = higher chance -> fert and civ at 1 is highest chance
                // temp at 0.5 = highest chance, temp at 0 or 1 is lowest chance
                var chance = (fertility + civilization + (-4*temperature*temperature + 4 * temperature)) / 3; // I don't like this.. TODO think of a better way
                
                // "fuzz" the slope line a little
                if (this.getTerrainAngle(x + (50*gridPos.x), y + (50*gridPos.y)) > Math.PI/6) {
                    chance = chance / 2;
                }
                
                rand = Math.random(); // *3 is to reduce the frequency of spawning.. quick and dirty
                if (rand < chance) {
                    // We need to spawn an object that fits the current environmental conditions
                    // start by querying the DB with the current environmental values
                    var msg = {}; //essentially the query obj

                    // Range queries are used to match against DB objects
                    msg = {
                        index: "anotherend-objects",
                        body: {

                            from: 0,
                            size: 100,
                            query:{
                                bool: {
                                    must: [
                                        {match: {BaseObject : true}},
                                        {range: { "EnvironmentalParams.fertMin": { lte: fertility} }},
                                        {range: { "EnvironmentalParams.fertMax": { gte: fertility} }},
                                        {range: { "EnvironmentalParams.tempMin": { lte: temperature} }},
                                        {range: { "EnvironmentalParams.tempMax": { gte: temperature} }},
                                        {range: { "EnvironmentalParams.civMin": { lte: civilization} }},
                                        {range: { "EnvironmentalParams.civMax": { gte: civilization} }}
                                    ]
                                }

                            }

                        },
                        cache: {
                            fertility: fertility,
                            civilization: civilization,
                            temperature: temperature
                        }
                    };

                    self.requestQueue.push({msg: msg, x:(gridPos.x*50 + x), y:(gridPos.y*50 + y), gridPos: gridPos, fertility: fertility});

                }
            }
        }

    }
};

EnvironmentGenerator.prototype.queryDBForObjects = function(cache, msg, x, y, fertility, id) { // ID for upgrading
    /* OBJECT FORMAT
    {
        //object properties
        id: 0,
        name: "tree",
        alignToTerrainHeight: true,
        alignToTerrainNormal: false,
        position: {x: 0, y: 0, z: 0},
        rotation: {x: 0, y: 0, z: 0},
        scale: {x: 1.0, y: 1.0, z: 1.0},

        //pieces
        pieces : [
            { 
                //this one has all of the properties of a piece
                url: "assets/basic/Leaves/Leaf_01.js",
                offset: {x: 0, y: 2, z: 0},
                rotation: {x: 0, y: 0, z: 3.14 * Math.random()},
                scale: {x: 1, y: 1, z: 1},
                color1 : [0.0, 0.0, 1.0],
                color2 : [1.0, 0.0, 0.0]
            },
            { 
                url: "assets/basic/Trees/Tree_01/Trunk_01.js"
            }
        ],

        //light format
        light :{
            offset: {x: 0, y: 5, z:0},
            color: 0x7788FF,
            radius: 20,
            intensity: 1
        },

        //physics collider
        collider :{
            type: 0,
            radius: 1.5
        }
    }
    */
    
    var self = this;
    
    var objects = {
        id: ((id) ? id : this.lastObjID),
        name: "GroupTestObject", // todo - to change?
        position: {x:x, y:0, z:y},
        rotation: {x:0, y:Math.random()*Math.PI*2, z:0},
        scale: {},
        alignToTerrainHeight: true,
        alignToTerrainNormal: false,
        listeners: [],
        pieces: [],
        collider : {
            type: 0,
            radius: 0.5
        }
    };
    if (!id)
        this.lastObjID ++;
    var promise = new Promise(function(resolve, reject) {
        // Check if response is cached before going out to the DB
        var newRequest = true;
        if (self.cachedResponse != null) {
            //console.log("Cached objects: " + self.cachedResponse.response.hits.hits.length);
            newRequest = false;
            // check message vs cached message
            if (Math.abs(msg.cache.fertility - self.cachedResponse.fertility) > 0.1 || 
                Math.abs(msg.cache.civilization - self.cachedResponse.civilization) > 0.15 ||
                Math.abs(msg.cache.temperature - self.cachedResponse.temperature) > 0.2 )
                newRequest = true; // we need a new request
        }
        
        if (newRequest) {
            // cache msg parameters
            if (cache) {
                self.cachedResponse = {
                    fertility: msg.cache.fertility,
                    civilization: msg.cache.civilization,
                    temperature: msg.cache.temperature
                }
            }
            delete msg.cache;
            self.elasticClient.search(msg).then(
                function( response ) 
                    {
                        // cache the response
                        if (cache)
                            self.cachedResponse.response = response;
                        self.createObjectFromResponse(response, objects).then(
                            function(objResponse) {
                                resolve(objResponse);
                            }, function(error) {
                                console.log("New request response object FAILURE for the below message: ");
                                console.log(JSON.stringify(msg));
                            });
                    },
                    function(error)
                    {
                        reject(JSON.stringify(error));
                    }
            );
        } else {
            self.createObjectFromResponse(self.cachedResponse.response, objects).then(
                function(response) {
                    resolve(response);
                }, function( error) {
                    console.log("Cached response object FAILURE");
                });
        }
    });
    return promise;
}

EnvironmentGenerator.prototype.createObjectFromResponse = function(response, objects) { // objects is the base object from queryDBForObjects
    var self = this,
        fertility = (this.cachedResponse != null ? this.cachedResponse.fertility : 1);
    
    var promise = new Promise(function(resolve, reject) {
        // The response contains all objects which are valid for this location. Randomly pick one.
        //console.log(response.hits.hits.length + " matching objects found. for position: " + x + "," + y + ", and fertility: " + fertility);
        if (response.hits.hits.length === 0) {
            return;
        }
        var randInd = Math.round(Math.random() * (response.hits.hits.length-1));
        var objToParse = response.hits.hits[randInd]._source;
        objects.type = response.hits.hits[randInd]._type;

        // Add scale to object
        var scale;
        if (objects.type === "Tree") {
            // Tree scale increases with Fertility for Zara
            scale = map_range(fertility, 0.3, 1, objToParse.Scale.min, objToParse.Scale.max);
        } else {
            scale = Math.random()*(objToParse.Scale.max - objToParse.Scale.min) + objToParse.Scale.min;
        }
        objects.scale.x = scale;
        objects.scale.y = scale;
        objects.scale.z = scale;
        
        // Add collision mesh if applicable
        if (objToParse.hasOwnProperty("Collision")) {
            if (objToParse.Collision === "") {
                delete objects.collider;
            }else {
                objects.collider.type = 2;
                objects.collider.radius = 5;
                objects.collider.url = objToParse.Collision;
            }
        }
        // get colour palette for this area
        // Get the "Biome" colour from the colour simplex noise map, and map to a degree position on the colour wheel
        var glyphBiome = self.getGlyphBiome({x:objects.position.x, y:objects.position.z});
        var DBpalette = {},
            palette = {};
        if (glyphBiome != null) {
            DBpalette = self.glyphBiomes[glyphBiome].palette;
        } else {
            // Get the correct palette from the colour map
            var colourWheel = map_range(self.simplex.noise3D( 0.0005*objects.position.x, 0.0005*objects.position.z, self.colourSeed), 0, 1, 0, 360);
            var sliceSize = 360 / self.palettes.length;
            var slice = Math.floor(colourWheel / sliceSize);
            // Pick two random colours from the palettes
            DBpalette = self.palettes[slice];
        }
        var randcolind = Math.round(Math.random() * (DBpalette.objects.length-1)),
            randcolind2 = Math.round(Math.random() * (DBpalette.objects.length-1)),
            subObjCol1 = Math.round(Math.random() * (DBpalette.objects.length-1)),
            subObjCol2 = Math.round(Math.random() * (DBpalette.objects.length-1));
        while (randcolind === randcolind2) {
            randcolind2 = Math.round(Math.random() * (DBpalette.objects.length-1));
        }
        while (subObjCol1 === randcolind2 || subObjCol1 === randcolind) {
            subObjCol1 = Math.round(Math.random() * (DBpalette.objects.length-1));
        }

        palette.colour1 = [DBpalette.objects[randcolind][0],DBpalette.objects[randcolind][1],DBpalette.objects[randcolind][2]];
        palette.colour2 = [DBpalette.objects[randcolind2][0],DBpalette.objects[randcolind2][1],DBpalette.objects[randcolind2][2]];
        
        var stateRand = Math.random();
        var objState;
        
        // SPE-472 align more objects to terrain normal
        if (objects.type === "Rock" || objects.type === "Bush" || objects.type === "Pillar")
            objects.alignToTerrainNormal = true;
        
        // Ruins should generate damaged most of the time, other objects should not
        if (objects.type === "Religious" || objects.type === "Human" || objects.type === "Building") {
            objects.alignToTerrainNormal = true;
            if (stateRand < 0.1)
                objState = EnvironmentGenerator.ObjectStates.UNDAMAGED;
            else if (stateRand < 0.5)
                objState = EnvironmentGenerator.ObjectStates.DAMAGED;
            else
                objState = EnvironmentGenerator.ObjectStates.DESTROYED;
        } else {
            if (stateRand < 0.1)
                objState = EnvironmentGenerator.ObjectStates.DESTROYED;
            else if (stateRand < 0.3)
                objState = EnvironmentGenerator.ObjectStates.DAMAGED;
            else
                objState = EnvironmentGenerator.ObjectStates.UNDAMAGED;
        }
        objects.state = objState;

        var randAngle = (numToGenerate > 1) ? Math.PI*2*Math.random() : - (Math.PI*2),// don't rotate single piece objects for collision purposes - compensate by - PI*2
            numToGenerate = Math.round(Math.random()*(objToParse.BaseFiles["max#"] - objToParse.BaseFiles["min#"])) + objToParse.BaseFiles["min#"];
       for (var n=0; n < numToGenerate; n++) {
            // ASSUMPTION - there will always be exactly the same # of filepaths in each state
            var filePath = {};
            for (var state in objToParse.BaseFiles.filepaths) {
                filePath[state] = objToParse.BaseFiles.filepaths[state][Math.floor(Math.random()*objToParse.BaseFiles.filepaths[objState].length)];
            }
            objects.pieces.push(self.createObjectPieceJSON({x:0, y:0, z:0}, {x:0, y: (randAngle + Math.PI*2*n/numToGenerate), z:0},{x:1, y:1, z:1}, filePath, palette.colour1, palette.colour2));
        }
        // Now query subObjects, if any
        var subObjects = objToParse.ChildObjects;
        var subObjectPalette = {colour1: DBpalette.objects[subObjCol1],//colResponse.hits.hits[srandcolind]._source.colour1,
                       colour2: DBpalette.objects[subObjCol2]};//colResponse.hits.hits[srandcolind2]._source.colour1 };

        if (subObjects.length > 0) {
            //console.log("Searching for " + subObjects.length + " sub object types");
            // construct array of IDS to search for
            var subObjectsToLoad = subObjects.length,
                subObjectsLoaded = 0;
            // Query the DB for each type of subobject.
            // TODO: Optimize - this could be combined into 1 DB call and save a lot of time
            for (var j=0; j < subObjects.length; j++) {
                var idsToSearch = [];
                //console.log("Searching for " + subObjects[j].length + " sub objects");
                // We don't do the rand search here, it is done below after the files are returned.
                for (var l = 0; l < subObjects[j].databaseId.length; l++) {
                    idsToSearch.push(subObjects[j].databaseId);
                }
                var subMSG = {
                    index: "anotherend-objects",
                    body: {
                        size: 50,
                        query: {
                            ids: { values: idsToSearch }
                        }
                    }
                }
                self.queryDBForSubObjects(subMSG, objects, subObjects[j], fertility, subObjectPalette).then(
                    function(response) {
                        objects = response.objects;
                        subObjectsLoaded ++;

                        if (subObjectsLoaded === subObjectsToLoad) {
                            //console.log("All Subobjects Loaded for gridPos: " + gridPos.x + ", " + gridPos.y + " at local position: " + x + ", " + y);
                            resolve({objects:objects});
                        }
                    }, function(error) {
                        console.log(JSON.stringify(error));
                    });

            }
        } else {
            // If no subobjects, just send back what we have so far
            resolve({objects:objects});
        }
    });
    
    return promise;
}

EnvironmentGenerator.prototype.queryDBForSubObjects = function(msg, objects, subObjectProperties, fertility, palette) {
    var self = this;
    
    var colour1 = palette.colour1,
        colour2 = palette.colour2;
    var promise = new Promise(function(resolve, reject) {
        self.elasticClient.search(msg).then(
            function(subResponse, test) {
                if (subResponse.hits.hits.length === 0) {
                    console.log("No Sub-Objects found......");

                } else {
                    var randInd = Math.round(Math.random() * (subResponse.hits.hits.length-1));
                    var subFilePath = {};
                    for (state in subResponse.hits.hits[randInd]._source.BaseFiles.filepaths) {
                        // TODO - update DB, and pass damaged / destroyed versions
                        subFilePath[state] = subResponse.hits.hits[randInd]._source.BaseFiles.filepaths[state][0]; // TODO - remove hardcode.. incase more than one subFile
                    }
                    // Create different number of subobjects based on its properties
                    if (subObjectProperties.fertAffected) {
                        var numToCreate = (fertility > 0.5 ) ? (Math.round((subObjectProperties.maxNum - subObjectProperties.minNum) * map_range(fertility, 0.5, 1, 0, 1)) + subObjectProperties.minNum): 0;
                    } else {
                        var numToCreate = Math.round(Math.random() * (subObjectProperties.maxNum - subObjectProperties.minNum)) + subObjectProperties.minNum;
                    }
                    
                    var scale = Math.random()*(subResponse.hits.hits[randInd]._source.Scale.max - subResponse.hits.hits[randInd]._source.Scale.min) + subResponse.hits.hits[randInd]._source.Scale.min;
                    for (var i=0; i < numToCreate; i++) {
                        // Quick and dirty positioning for the demo
                        var position = {x:0, y: 0, z:0};
                        var range = subObjectProperties.maxHeight - subObjectProperties.minHeight;
                        if (subResponse.hits.hits[randInd]._type === "Leaf") {
                            
                            position = pointInSphere(0, (subObjectProperties.minHeight + range/2)*objects.scale.x, 0, subObjectProperties.radius*objects.scale.x);
                            // re-map to within acceptable y limits - the above line uses a radius that would put leaves too high or low
                            position.y = (Math.random()*range + subObjectProperties.minHeight)*objects.scale.x;
                            rotation = {x:3.14*Math.random(), y: 3.14*Math.random(), z:3.14*Math.random()};
                        } else if (subResponse.hits.hits[randInd]._type === "Branch") {
                            position = {x:0, y: (Math.random()*range + subObjectProperties.minHeight)*objects.scale.x, z:0};
                            rotation = {x:0, y: 2*3.14*Math.random(), z:0};
                        }
                        //console.log("Leaf Position: [" + position.x + ", " + position.y + ", " + position.z);
                        objects.pieces.push(self.createObjectPieceJSON(position,rotation, {x:scale, y: scale, z:scale}, subFilePath, colour1, colour2));
                    }

                }
                resolve({objects:objects});

            }, function(error) {
                console.log("Erroring out at Sub Objects.");
                reject(JSON.stringify(error));
            }
        );
    });
    return promise;
}

EnvironmentGenerator.prototype.createObjectPieceJSON = function(position, rotation, scale, objectFileName, colour1, colour2) {
    //this is what will be recieved from the server
    var obj = {
        url: objectFileName,
        offset: {x: position.x, y: position.y, z: position.z}, // N.B this position is RELATIVE to the global position
        rotation: {x: rotation.x, y: rotation.y, z: rotation.z},
        scale: {x: scale.x, y: scale.y, z: scale.z},
        color1: colour1,
        color2: colour2
    };

    return obj;
}

EnvironmentGenerator.prototype.runObjectQueue = function() {
    // Run first object in queue, then splice
    var self = this;
    this.inQueue = true;
    var promise = new Promise(function(resolve, reject) {
        // Check if the queue has been cancelled
        if (self.cancelQueue) {
            console.log("Queue has been cancelled - aborting generation");
            resolve(true);
        }
        
        //console.log("Queue has : " + self.requestQueue.length + " requests.");
        //if (self.requestQueue.length % 100 === 0)
        //    console.log("Queue length update: " + self.requestQueue.length);
        if (self.requestQueue.length > 0) {
            var req = self.requestQueue[0];
            //console.log("Request msg: " + JSON.stringify(req.msg));
            self.queryDBForObjects(true, req.msg, req.x, req.y, req.fertility).then(
                function(response) {
                    //console.log("Promise fulfilled for: " + response.x + ", " + response.y);
                    if (response.objects === [])
                        console.log("WARN - empty array returned");
                    self.NewObjects[req.gridPos.x][req.gridPos.y].push(response.objects);
                    self.requestQueue.splice(0,1);
                    self.runObjectQueue().then(
                        function(response) {
                            resolve(true);
                        }, function(error) {
                            reject(error);
                        });
                }, function(error) {
                    console.log("Erroring out at runObjectQueue");
                    reject(JSON.stringify(error));
                });
        } else {
            // end queue and clean up the cache
            self.inQueue = false;
            self.cachedResponse = null;
            resolve(true);
        }
    });
    return promise;
}

EnvironmentGenerator.prototype.getGlyphBiome = function(pos) {
    var glyphBiome = null;
    for (var i in this.glyphBiomes) {
        if (distance(pos.x, pos.y, this.glyphBiomes[i].x, this.glyphBiomes[i].z) < this.glyphBiomes[i].radius) {
            glyphBiome = i;
            break;
        }
    }
    return glyphBiome;
}

// Event Listeners

EnvironmentGenerator.prototype.addObjectListener = function(objID, nodeID, listener, title) {
    //console.log("Adding listener for objID: " + objID + " and node: " + title);
    if (this.GeneratedObjectsByID[objID] === undefined) {
        console.log("Warn: Object " + objID + " is not defined.. Object Listener Aborted for node: " + title);
        return;
    }
    //console.log("Object type: " + this.GeneratedObjectsByID[objID].type);
    if (!this.GeneratedObjectsByID[objID].hasOwnProperty("listeners")) {
        this.GeneratedObjectsByID[objID].listeners = [];
    }
    this.GeneratedObjectsByID[objID].listeners.push({
        nodeID: nodeID,
        listener: listener
    });
    //console.log("Listener Pushed to environment Object: " + objID + " for node: " + title);
};
EnvironmentGenerator.prototype.removeObjectListener = function(objID, nodeID, listenerID, title) {
    //console.log("Removing Object Listener for obj: " + objID + " and node: " + nodeID);
    if (this.GeneratedObjectsByID[objID] == undefined || !this.GeneratedObjectsByID[objID].hasOwnProperty("listeners")) {
        console.log("WARN: node: " + title + " - Cannot remove listener from Obj " + objID + " because it has no listeners..");
        return false;
    }
    var listeners = this.GeneratedObjectsByID[objID].listeners;
    for (var i= listeners.length-1; i >= 0; i--) {
        if (listeners[i].listener.id === listenerID && listeners[i].nodeID === nodeID) {
            // Splice
            this.GeneratedObjectsByID[objID].listeners.splice(i, 1);
            return true;
        }
    }
    return false;
};

/*
    =============== Story Generator functions ===============
*/

EnvironmentGenerator.prototype.chooseLocationForStoryNode = function() {
    // Pick a gridsquare / position nearby the player, but not TOO close
    var test = false; //ensure this area is finished generating
    while (test === false) {
        test = true;
        var position = {
            x: (Math.random()*300 + 60)*((Math.random() > 0.5) ? 1 : -1) + this.playerPosition.x*50,
            y: 0,
            z: (Math.random()*300 + 60)*((Math.random() > 0.5) ? 1 : -1) + this.playerPosition.y*50
        };
        var gridPos = {x: Math.floor(position.x / 50), y: Math.floor(position.z / 50)};
        for (var i in this.glyphBiomes) {
            if (distance(this.glyphBiomes[i].x, this.glyphBiomes[i].z, position.x, position.z) < 50) {
                test = false;
                break;
            }
        }
        if (typeof(this.GeneratedObjects[gridPos.x]) == 'undefined' || typeof(this.GeneratedObjects[gridPos.x][gridPos.y]) == 'undefined')
            test = false;
    }
    //console.log("New story node position: x: " + position.x + ", z: " + position.z)
    return position;
}

EnvironmentGenerator.prototype.getObjectForStoryNode = function(pos, dbObj) {
    // We want to get objects near the chosen location
    
    // First translate pos to a gridPos to search in
    var gridPos = {x: Math.floor(pos.x / 50), y: Math.floor(pos.z / 50)};
    
    // get all objects that match the criteria for this gridSquare
    // If none, we move on to a nearby gridsquare
    var objectMatch = [],
        tries = 0;
    
    while (objectMatch.length === 0) {
        if (tries > 15) { // TODO - tune
            //console.log("Node unable to find an object after " + tries + " tries.");
            return false;
        }
        
        // If we've gone outside the generated area.. return false for now
        if (typeof(this.GeneratedObjects[gridPos.x]) == 'undefined' || typeof(this.GeneratedObjects[gridPos.x][gridPos.y]) == 'undefined') {
            //console.log("Aborting node due to ungenerated area after: " + tries + " tries. Searching for: " + dbObj.type + " with state: " + dbObj.state);
            return false;
        }
        
        // find a matching object
        for (var i=0; i < this.GeneratedObjects[gridPos.x][gridPos.y].length; i++) {
            var o = this.GeneratedObjects[gridPos.x][gridPos.y][i];
            if (o.type === "GlyphTower" || o.type === "GlyphPillar" || o.type === "Glyph")
                continue;
            if ((dbObj.type === "any" || o.type === dbObj.type) && (dbObj.state === null || o.state === dbObj.state)) {
                if (!o.hasOwnProperty("listeners") || o.listeners.length === 0) // SPE-418 - don't return objects that already have a listener
                    objectMatch.push(o);
            }
        }

        // try another gridSquare - randomly move one gridsquare
        var rand = Math.random();
        if (rand > 0.5) {
            if (typeof(this.GeneratedObjects[gridPos.x + 1]) == 'undefined')
                gridPos.x -= 1;
            else if (typeof(this.GeneratedObjects[gridPos.x - 1]) == 'undefined')
                gridPos.x +=1
            else
                gridPos.x = (rand > 0.75) ? gridPos.x + 1 : gridPos.x - 1;
        } else {
            if (typeof(this.GeneratedObjects[gridPos.x][gridPos.y + 1]) == 'undefined')
                gridPos.y -= 1;
            else if (typeof(this.GeneratedObjects[gridPos.x][gridPos.y - 1]) == 'undefined')
                gridPos.y +=1
            else
                gridPos.y = (rand > 0.25) ? gridPos.y + 1 : gridPos.y - 1;
        }
        tries ++;


        if (objectMatch.length > 0) {
            // We've found something - return it
            return objectMatch[Math.floor(Math.random()*objectMatch.length)];
        }
        // continue loop if no objects are valid
        objectMatch = [];
    }
    console.log("Env Generator - getObjectForStoryNode loop failure");
    return false;
}

EnvironmentGenerator.prototype.nodeGenerateObjects = function(position, objects, assocObjs) {
    // First, determine max radius of objects
    var maxDist = 0;
    //console.log("nodeGenerateObjects for : " + objects.length + " objects - " + this.cachedResponse);
    for (var i=0; i < objects.length; i++) {
        objects[i].position.x += position.x;
        objects[i].position.z += position.z;
        var dist = distance(position.x, position.z, objects[i].position.x, objects[i].position.z)
        if ( dist > maxDist)
            maxDist = dist;
    }
    
    
    // Then determine grid square of position and any other grid squares that fall within the radius
    var gridSquares = [];
    gridSquares.push({x: Math.floor(position.x/50), y:Math.floor(position.z/50)});
    
    var gSs = [{x: Math.floor((position.x-25)/50), y:Math.floor(position.z/50)},
               {x: Math.floor((position.x-25)/50), y:Math.floor((position.z-25)/50)},
               {x: Math.floor((position.x-25)/50), y:Math.floor((position.z+25)/50)},
               {x: Math.floor(position.x/50), y:Math.floor((position.z-25)/50)},
               {x: Math.floor(position.x/50), y:Math.floor((position.z+25)/50)},
               {x: Math.floor((position.x+25)/50), y:Math.floor((position.z-25)/50)},
               {x: Math.floor((position.x+25)/50), y:Math.floor(position.z/50)},
               {x: Math.floor((position.x+25)/50), y:Math.floor((position.z+25)/50)}]
    for (var i=0; i < gSs.length; i++) {
        //console.log("Gridsquares affected: " + gSs[i].x + ", " + gSs[i].y);
        if (gridSquares.indexOf(gSs[i]) === -1)
            gridSquares.push(gSs[i]);
    }
    
    // Find all objects that fall within this radius and store in an array - splice them from their grid squares
    // assocObjs are the objects already associated with the node
    // Don't splice any assocObjects or objects that are attached to another node
    var removeObjs = [];
    for (var g = 0; g < gridSquares.length; g++) {
        // check if gridsquare exists
        if (typeof(this.GeneratedObjects[gridSquares[g].x]) == 'undefined' || typeof(this.GeneratedObjects[gridSquares[g].x][gridSquares[g].y]) == 'undefined')
            continue;
        
        var gS = this.GeneratedObjects[gridSquares[g].x][gridSquares[g].y];
        for (var o=gS.length - 1; o >= 0; o--) {
            if (distance(gS[o].position.x, gS[o].position.z, position.x, position.z) < maxDist) {
                // check if in assocObjs
                var assocObj = false;
                for (var j=0; j < assocObjs.length; j++) {
                    if (assocObjs[j].position === gS[o].position && assocObjs.type === gS[o].type)
                        assocObj = true;
                }
                if (assocObj)
                    continue;
                
                // Or if it has a listener for another node
                if (gS[o].hasOwnProperty("listeners") && gS[o].listeners.length > 0)
                    continue;
                
                // If it has passed the above tests, add it to the remove array and then splice it
                //console.log("OBJECT BEING REMOVED");
                removeObjs.push(gS[o].id);
                gS.splice(o, 1);
            }
        }
    }
    // Generate / Add in the new objects to their appropriate grid square
    var self = this,
        addObjs = [];
    var promise = new Promise(function(resolve, reject) {
        var count = 0;
        for (var i=0; i < objects.length; i++) {
            
            var addmsg = {
                index: "anotherend-objects",
                type: objects[i].type,
                cache: {
                    fertility: 0,
                    civilization: 0,
                    temperature: 0
                },
                body: {
                    size: 100
                }
            };
            //console.log("Generating object for nodeGenerateObject");
            self.generateObjectForNode(addmsg, objects[i]).then(
                function(objResponse) {
                    addObjs.push(objResponse);
                    count ++;
                    //console.log(count + " of " + objects.length + " objects generated for a node");
                    if (count === objects.length) {
                        // Return the removed objects array and the generated objects array
                        resolve({objsToRemove: removeObjs, objsToAdd: addObjs});
                    }   
                }, function(objError) {
                    reject(objError);
                    console.log("nodeGenerateObjects error");
                });
        }
    });
    return promise; 
}

EnvironmentGenerator.prototype.generateObjectForNode = function(msg, objProps) {
    var gridPos = {x: Math.floor(objProps.position.x/50), y:Math.floor(objProps.position.z/50)};
    var self = this;
    var promise = new Promise(function(resolve, reject) {
        self.queryDBForObjects(false, msg, objProps.position.x, objProps.position.z, self.simplex.noise3D( 0.003*objProps.position.x, 0.003*objProps.position.z, self.fertSeed)).then(
            function(objResponse) {
                objResponse.objects.state = objProps.state;
                // add object to generatedObjects
                if (typeof(self.GeneratedObjects[gridPos.x]) == 'undefined') {
                    self.GeneratedObjects[gridPos.x] = [];
                }
                if (typeof(self.GeneratedObjects[gridPos.x][gridPos.y]) == 'undefined') {
                    self.GeneratedObjects[gridPos.x][gridPos.y] = [];
                }
                self.GeneratedObjects[gridPos.x][gridPos.y].push(objResponse.objects);
                self.GeneratedObjectsByID[objResponse.objects.id] = objResponse.objects;
                resolve(objResponse.objects);
            }, function(objError) {
                reject(error);
            });
    });
    return promise
}


/*
    =============== Utility functions ===============
*/

function map_range(value, low1, high1, low2, high2) {
    return low2 + (high2 - low2) * (value - low1) / (high1 - low1);
}

function distance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

function pointInSphere( x, y, z, radius )
{
    var dir = [
        -1 + Math.random() * 2,
        -1 + Math.random() * 2,
        -1 + Math.random() * 2,
    ];
    var len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    var newLen = Math.random() * radius;
    var pos = {
        x:(dir[0] / len) * newLen + x,
        y:(dir[1] / len) * newLen + y,
        z:(dir[2] / len) * newLen + z
    };
    
    //console.log("Point in Sphere results: " + distance(pos.x, pos.y, x, y) + ", radius: " + radius);
    
    return pos;
}
function HSVtoRGB(h, s, v) { // http://stackoverflow.com/questions/17242144/javascript-convert-hsb-hsv-color-to-rgb-accurately   
    var r, g, b, i, f, p, q, t;
    i = Math.floor(h * 6);
    f = h * 6 - i;
    p = v * (1 - s);
    q = v * (1 - f * s);
    t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }
    return [r, g, b];
}

/////////////////////////////////////
//           ENUMERATORS           //
/////////////////////////////////////

EnvironmentGenerator.ObjectStates = {
    UNDAMAGED : 0,
    DAMAGED : 1,
    DESTROYED : 2
};