// Visualizations can be viewed at:
// http://iv.csit.carleton.ca/~awhitehe/research/StoryVisualizer/
//
// ================================================================
google.load('visualization', '1.0', {'packages':['corechart']});
google.setOnLoadCallback(initialize);
var graph;
function initialize() {
    graph = new Renderer();
    //gameSelect();
}
function gameSelect(gid) {
    //var gid = $("#gameSelect").val()
    var query = new google.visualization.Query('https://docs.google.com/spreadsheets/d/1tkW_RSxZfDsPw8PN2ZHo3v-jDCwlGOwyotfIIY9lSCk/gviz/tq?gid=' + gid);
    
    switch($("input:radio[name='graphType']:checked").val()) {
        case 'arc':
            query.setQuery("Select A,B,C,D,G,H,I WHERE A CONTAINS 'Plot-Driven' OR A CONTAINS 'Character-Driven'");
            break;
        case 'charInteractions':
            query.setQuery("Select A,B,D,E,F WHERE A CONTAINS 'Plot-Driven' OR A CONTAINS 'Character-Driven'");
            break;
        case 'both':
            query.setQuery("Select A,B,C,D,E,F,G,H,I WHERE A CONTAINS 'Plot-Driven' OR A CONTAINS 'Character-Driven'");
            break;
    }
    performQuery(query, gid);
    
    // change the screen title
    $("#gameTitle").text(Renderer.gameNames[gid]);
}

function performQuery(query, gid) {
    var testVar = "testing";
    query.send(function(response) {
        if (response.isError()) {
            console.log("Error in Query: " + response.getMessage() + " " + response.getDetailedMessage());
            return;
        }
        // set variables with the returned data
        var nodes = response.getDataTable();
        //graph.zoom = 1;
        //graph.translate = {x:0, y:0};
        
        // Map column indices to their names
        var key = {};
        for (var i=0; i < nodes.getNumberOfColumns(); i++) {
            key[nodes.getColumnLabel(i)] = i;
        }

        // if the graph type needs characters, get them before assigning the variables, so rendering doesn't get messed up
        if ($("input:radio[name='graphType']:checked").val() != "arc") {
            var query = new google.visualization.Query('https://docs.google.com/spreadsheets/d/1tkW_RSxZfDsPw8PN2ZHo3v-jDCwlGOwyotfIIY9lSCk/gviz/tq?gid=' + gid);
            query.setQuery("Select K,M,N,O WHERE K IS NOT null AND K <> 'Name'");
            query.send(handleQueryResponseCharacters);
        } else {
            // see if the response is the longest for normalizing:
            graph.longestGraphLength = Math.max(graph.longestGraphLength, nodes.getNumberOfRows()*graph.defaultNodeSpacing);
            graph.data.push({
                gid: gid,
                nodes: nodes,
                key: key
            });
            //graph.data = nodes.Lf;
            //graph.key = key;
            graph.graphType = $($("input:radio[name='graphType']:checked")).val();
        }

        function handleQueryResponseCharacters(resp) {
            // parse characters into nicer data form
            var data = resp.getDataTable(),
                chars = [];

            for (var i=0; i < data.getNumberOfRows(); i++) {
                chars.push({
                    name: (data.getFormattedValue(i,0) != "") ? data.getFormattedValue(i,0) : null,
                    propp: (data.getFormattedValue(i,1) != "") ? data.getFormattedValue(i,1) : null,
                    campbell: (data.getFormattedValue(i,2) != "") ? data.getFormattedValue(i,2): null,
                    vogler: (data.getFormattedValue(i,3) != "") ? data.getFormattedValue(i,3) : null,
                    color: "#000000".replace(/0/g,function(){return (~~(Math.random()*16)).toString(16);}) // http://stackoverflow.com/questions/5092808/how-do-i-randomly-generate-html-hex-color-codes-using-javascript
                });
            }
            graph.longestGraphLength = Math.max(graph.longestGraphLength, nodes.getNumberOfRows()*graph.defaultNodeSpacing);
            graph.data.push({
                gid: gid,
                nodes: nodes,
                key: key,
                characters: chars
            });
            //graph.characters = chars;
            //graph.data = nodes.Lf;
            //graph.key = key;
            graph.graphType = $($("input:radio[name='graphType']:checked")).val();
        }
    });
}

var Renderer = function() {
    var canvas = document.getElementById("canvas");
    this.ctx = canvas.getContext("2d");
    this.ctx.canvas.height = $("#canvasWrapper").height() - 60;
    this.ctx.canvas.width = $("#canvasWrapper").width();
    
    this.graphType = $("input[name='graphType']:checked").val();
    
    this.translate = {x: 0, y: 0};
    this.zoom = 1;
    this.baseline = 300;
    
    this.graphSpacing = 400;
    this.longestGraphLength = 0;
    this.defaultNodeSpacing = 50;
    
    this.data = [];
    // arc variables
    
    this.showNarrativeStructures = true;
    this.infoHook = null;
    this.normalize = false;
    
    // character interaction variables
    this.characters = [];
    
    
    // mouse event listeners
    var self = this;
    this.mouseDown = null;
    canvas.addEventListener("mousewheel", function(e) {self.zoomGraph(e);}, false);
    canvas.addEventListener("mousedown", function(e) { self.mouseDown = {x:e.screenX,y:e.screenY};}, false);
    canvas.addEventListener("mouseup", function(e) { self.mouseDown = null;}, false);
    canvas.addEventListener("mousemove", function(e) { self.moveMouse(e);}, false);
    canvas.addEventListener("click", function(e) {self.mouseClick(e);});
    
    // radio event listeners
    $("input:radio[name='graphType']").change(
        function() {
            self.translate = {x:0, y:0};
            self.zoom = 1;
            var gids = [];
            for (var i=0; i < self.data.length; i++) {
                gids.push(self.data[i].gid);
            }
            self.data = [];
            for (var j=0; j < gids.length; j++) {
                gameSelect(gids[j]);
            }
        }
    );
    
    // game select event listeners
    $(".gameSelect > li").click(function() {
        // if its selected, remove it from the render queue
        // if not, it will be added when the response comes back
        var elem = $(this);
        if (elem.hasClass("selected")) {
            for (var i=self.data.length - 1; i >= 0; i--) {
                // also remove the baselines of all graph so they recalculate
                delete self.data[i].baseline;
                if (self.data[i].gid === elem.data().gid) {
                    self.data.splice(i, 1);
                }
            }
        } else {
            gameSelect(elem.data().gid);
        }
        
        elem.toggleClass("selected");
    });
    
    
    
    // start rendering
    window.requestAnimationFrame(function(time) {
        self.render.call(self, time);
    });
}

Renderer.prototype.render = function(time) {
    var self = this;
    
    this.ctx.clearRect(0,0, this.ctx.canvas.width, this.ctx.canvas.height);
    // render the selected graph type
    switch(this.graphType) {
        case "arc":
            this.renderArcDiagram(true);
            break;
        case "charInteractions":
            this.renderCIDiagram(2, false);
            break;
        case "both":
            this.renderArcDiagram(false);
            this.renderCIDiagram(1, true)
            break;
    }
    
    // render the normalize button
    this.ctx.save();
        this.ctx.fillStyle = "#8c72aa";
        this.ctx.fillStyle= this.normalize ? '#8c72aa' : '#654f80';
        this.ctx.fillRect(this.ctx.canvas.width - 170, this.normalize ? 8 : 12, 158, 25);
        this.ctx.fillStyle = this.normalize ? '#654f80' : '#8c72aa';
        this.ctx.fillRect(this.ctx.canvas.width - 170, 10, 158, 25);
        this.ctx.fillStyle = "#eee";
        this.ctx.font = "10pt Arial";
        this.ctx.save();
        this.ctx.shadowColor = "#000";
        this.ctx.shadowBlur = 3;
        this.ctx.fillText("Normalize Graph Lengths", this.ctx.canvas.width - 165, 27);
        this.ctx.restore();
    this.ctx.restore();
    
    window.requestAnimationFrame(function(time) {
        self.render.call(self, time);
    });
}

Renderer.prototype.renderArcDiagram = function(showUI) {
    for (var g=0; g < this.data.length; g++) {
        var nodes = this.data[g].nodes,
            baseline,
            key = this.data[g].key,
            nodeSpacing = (this.normalize ? this.longestGraphLength / nodes.getNumberOfRows() : this.defaultNodeSpacing);
        
        if (!this.data[g].hasOwnProperty("baseline")) {
            if (this.graphType === "both") {
                // baseline must take into account heights of all graphs before it
                this.data[g].baseline = this.data[g].characters.length*75 + 150;
                for (var x = g-1; x >=0; x--) {
                    this.data[g].baseline += this.data[x].characters.length*150 + 300;             // use # of characters for graph spacing
                }
            } else {
                this.data[g].baseline = this.baseline + this.graphSpacing*g;
            }
        }
        
        baseline = this.data[g].baseline;
        
        var mains = [],
            chapts = [],
            evts = [];
        
        // Game Title
        this.ctx.save();
        this.ctx.lineWidth = 1;
        this.ctx.font = "14pt Arial";
        this.ctx.fillStyle = "#111";
        this.ctx.textAlign = "right";
        this.ctx.fillText(Renderer.gameNames[this.data[g].gid], (50 + this.translate.x )/ this.zoom, ((baseline + 3)/this.zoom + this.translate.y/this.zoom));
        this.ctx.restore();

        // Narrative Structure Labels
        if (this.showNarrativeStructures && showUI) {
            this.ctx.textAlign = "right";
            this.ctx.font = "11pt Arial";
            this.ctx.fillStyle = "#ddd";
            this.ctx.strokeStyle = "#c1bfb9";
            this.ctx.lineWidth = 0.5;

            this.ctx.fillText("Propp:", (150 + this.translate.x)/ this.zoom, (baseline/this.zoom + this.translate.y/this.zoom + 30));
            /*
            this.ctx.beginPath();
            this.ctx.moveTo((30 + this.translate.x)/ this.zoom,(this.baseline + this.translate.y + 53)/this.zoom);
            this.ctx.lineTo((10000 + this.translate.x)/ this.zoom, (this.baseline + this.translate.y + 53)/this.zoom);
            this.ctx.closePath();
            this.ctx.stroke();
            */
            this.ctx.fillText("Campell:", (150 + this.translate.x)/this.zoom, (baseline/this.zoom + this.translate.y/this.zoom + 53));
            this.ctx.fillText("Vogler:", (150 + this.translate.x)/this.zoom, (baseline/this.zoom + this.translate.y/this.zoom + 75));
            this.ctx.textAlign = "left";
        }

        for (var i=0; i < nodes.getNumberOfRows(); i++) {
            var dotX = (4*this.defaultNodeSpacing + i*nodeSpacing + this.translate.x)/this.zoom,
                dotY = (baseline + this.translate.y)/this.zoom;
            this.ctx.strokeStyle = "#eee";
            this.ctx.beginPath();
            this.ctx.moveTo(dotX, dotY);
            this.ctx.lineTo(dotX, dotY + 70);
            this.ctx.closePath();
            this.ctx.stroke();

            this.ctx.fillStyle = (nodes.getFormattedValue(i,key["EventType"]) == "Character-Driven") ? "#A7C5BD" : "#E5DDCB";
            this.ctx.beginPath();
            this.ctx.arc(dotX, dotY, (nodes.getFormattedValue(i,key["Importance"]) == "Kernel") ? 15/this.zoom : 8/this.zoom, 0, Math.PI*2);
            this.ctx.fill();
            this.ctx.closePath();

            if (nodes.getFormattedValue(i,key["Arc"]) == "Main") {
                mains.push({
                    importance: nodes.getFormattedValue(i,key["Importance"]),
                    type: nodes.getFormattedValue(i,key["EventType"]),
                    index: i
                });
            } else if (nodes.getFormattedValue(i,key["Arc"]) == "Chapter") {
                chapts.push({
                    importance: nodes.getFormattedValue(i,key["Importance"]),
                    type: nodes.getFormattedValue(i,key["EventType"]),
                    index: i
                });
            }
            this.ctx.lineWidth = 2;
            this.ctx.strokeStyle = '#b5a7b9';
            if (i > 0) {
                var rad = -25*(nodeSpacing/this.defaultNodeSpacing);
                this.ellipse(4*this.defaultNodeSpacing + i*nodeSpacing + rad, baseline, rad, 25);
            }
            if (this.showNarrativeStructures && showUI) {
                // Indicate Narrative Structure(s)
                this.ctx.fillStyle = "#000";
                this.ctx.font = Math.min(10, 10/this.zoom) + "pt Arial";
                this.ctx.save();
                this.ctx.translate(dotX, dotY);
                // Propp
                this.ctx.textAlign = "center";
                if (nodes.getFormattedValue(i,key["Propp's Function"]) != "") {
                    this.ctx.fillText(nodes.getFormattedValue(i,key["Propp's Function"]), 0, 28);
                }
                // Hero's Journey
                this.ctx.textAlign = "left";
                this.ctx.translate(-3,50)
                this.ctx.rotate(Math.PI/4);
                if (nodes.getFormattedValue(i,key["Hero's Journey"]) != "") {
                    this.ctx.fillText(nodes.getFormattedValue(i,key["Hero's Journey"]), 0, 0);
                }
                this.ctx.rotate(-Math.PI/4);
                // Writer's Journey
                this.ctx.translate(0, 20/(this.zoom > 1 ? this.zoom : 1));
                this.ctx.rotate(Math.PI/4);
                if (nodes.getFormattedValue(i,key["Writer's Journey"]) != "") {
                    this.ctx.fillText(nodes.getFormattedValue(i,key["Writer's Journey"]), 0, 0);
                }
                this.ctx.restore();
            }
        }
        //console.log(mains);
        // draw arcs between events
        this.ctx.lineWidth = 3.5;
        this.ctx.strokeStyle = '#657981';
        for (var m=1; m < mains.length; m++) {
            var rad = -1*((mains[m].index - mains[m-1].index)*50*(nodeSpacing/this.defaultNodeSpacing))/2;
            this.ellipse(4*this.defaultNodeSpacing + mains[m].index*nodeSpacing + rad, baseline, rad, 200);
        }
        this.ctx.lineWidth = 3;
        this.ctx.strokeStyle = '#809d91';
        for (var m=1; m < chapts.length; m++) {
            var rad = -1*((chapts[m].index - chapts[m-1].index)*50*(nodeSpacing/this.defaultNodeSpacing))/2;
            this.ellipse(4*this.defaultNodeSpacing + chapts[m].index*nodeSpacing + rad, baseline, rad, 75);
        }
        this.ctx.stroke();
    }
    if (showUI && this.infoHook != null && (this.infoHook.i >= 0 && this.infoHook.i < this.data[this.infoHook.graph].nodes.getNumberOfRows()))
            this.renderArcInformation();
    
    if (showUI)
        this.renderArcUI();
}
Renderer.prototype.renderArcInformation = function() {
    // parse / wrap text
    var headers = [],
        lines = [],
        data = this.data[this.infoHook.graph],
        baseline = this.baseline + (this.graphSpacing*this.infoHook.graph),
        ind = this.infoHook.i,
        nodeSpacing = (this.normalize ? this.longestGraphLength / data.nodes.getNumberOfRows() : this.defaultNodeSpacing);
    
    headers.push("- " + data.nodes.getFormattedValue(ind,data.key["Arc"]) + " Arc");
    headers.push("- " + data.nodes.getFormattedValue(ind,data.key["EventType"]));
    headers.push("- " + data.nodes.getFormattedValue(ind,data.key["Importance"]));
    
    lines = this.wrapText(data.nodes.getFormattedValue(ind,data.key["EventDescription"]));
    
    var actualX = (4*this.defaultNodeSpacing + ind*nodeSpacing + this.translate.x)/this.zoom;
    this.ctx.save();
    this.ctx.translate(actualX, (baseline + this.translate.y)/ this.zoom);
    this.ctx.fillStyle = (data.nodes.getFormattedValue(ind,data.key["EventType"]) == "Character-Driven") ? "#A7C5BD" : "#E5DDCB";
    var width = ($('canvas').width() - actualX > 300) ? 300 : -300;
    this.ctx.save();
    this.ctx.shadowColor = "#ccc";
    this.ctx.shadowBlur = 3;
    this.ctx.shadowOffsetY = 2;
    this.ctx.fillRect(0,25,width,lines.length*17 + 30 + headers.length*20);
    this.ctx.restore();
    
    
    // Render information
    this.ctx.save();
    this.ctx.font = "18px Arial";
    this.ctx.fillStyle = "#fff";
    this.ctx.shadowColor = "#050505";
    this.ctx.shadowBlur = 4;
    for (var i=0; i < headers.length; i++)
        this.ctx.fillText(headers[i], ($('canvas').width() - actualX > 300) ? 10 : -290, 50 + 20*i);
    this.ctx.restore();
    
    this.ctx.font = "14px Arial";
    this.ctx.fillStyle = "#333";
    for (var i=0; i < lines.length; i++)
        this.ctx.fillText(lines[i], ($('canvas').width() - actualX > 300) ? 10 : -290, 61 + (17*i) + (20*headers.length));
    this.ctx.restore();
}
Renderer.prototype.renderArcUI = function() {
    // UI
    this.ctx.fillStyle= this.showNarrativeStructures ? '#809d91' : "#657981";
    this.ctx.fillRect(22, this.showNarrativeStructures ? 8 : 12, 165, 25);
    this.ctx.fillStyle = this.showNarrativeStructures ? "#657981" : '#809d91';
    this.ctx.fillRect(22, 10, 165, 25);
    this.ctx.fillStyle = "#eee";
    this.ctx.font = "10pt Arial";
    this.ctx.save();
    this.ctx.shadowColor = "#000";
    this.ctx.shadowBlur = 3;
    this.ctx.fillText("Show Narrative Structures", 27, 27);
    this.ctx.restore();
    
    // LEGEND
    this.ctx.fillStyle = "rgba(220,220,220,0.8)";
    this.ctx.fillRect(10,this.ctx.canvas.height- 115,200,110);
    
    // Dots
    this.ctx.strokeStyle = "#333";
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = "#A7C5BD";
    this.ctx.beginPath();
    this.ctx.arc(25,this.ctx.canvas.height- 100, 8 , 0, Math.PI*2);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.closePath();
    
    this.ctx.fillStyle = "#E5DDCB";
    this.ctx.beginPath();
    this.ctx.arc(25,this.ctx.canvas.height- 80, 8 , 0, Math.PI*2);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.closePath();
    // Lines
    this.ctx.lineWidth = 3.5;
    this.ctx.strokeStyle = '#657981';
    this.ctx.beginPath()
    this.ctx.moveTo(17, this.ctx.canvas.height - 60);
    this.ctx.lineTo(45, this.ctx.canvas.height - 60);
    this.ctx.closePath();
    this.ctx.stroke();
    
    this.ctx.lineWidth = 3;
    this.ctx.strokeStyle = '#809d91';
    this.ctx.beginPath()
    this.ctx.moveTo(17, this.ctx.canvas.height - 40);
    this.ctx.lineTo(45, this.ctx.canvas.height - 40);
    this.ctx.closePath();
    this.ctx.stroke();
    
    this.ctx.lineWidth = 2;
    this.ctx.strokeStyle = '#b5a7b9';
    this.ctx.beginPath()
    this.ctx.moveTo(17, this.ctx.canvas.height - 20);
    this.ctx.lineTo(45, this.ctx.canvas.height - 20);
    this.ctx.closePath();
    this.ctx.stroke();
    
    // Text
    this.ctx.fillStyle = "#222";
    this.ctx.font = "11pt Arial";
    this.ctx.fillText("Character-Driven", 50, this.ctx.canvas.height- 95);
    this.ctx.fillText("Plot-Driven", 50, this.ctx.canvas.height- 75);
    this.ctx.fillText("Main Story Arc", 50, this.ctx.canvas.height- 55);
    this.ctx.fillText("Chapter Arc", 50, this.ctx.canvas.height- 35);
    this.ctx.fillText("Event", 50, this.ctx.canvas.height- 15);
    
}

Renderer.prototype.renderCIDiagram = function(thickness, arc) {
    for (var g=0; g < this.data.length; g++) {
        var nodes = this.data[g].nodes,
            characters = this.data[g].characters,
            key = this.data[g].key,
            baseline,
            nodeSpacing = (this.normalize ? this.longestGraphLength / nodes.getNumberOfRows() : this.defaultNodeSpacing);
        
        // baseline must take into account heights of all graphs before it
        if (!this.data[g].hasOwnProperty("baseline")) {
            var bs = characters.length*75 + 150;
            for (var x = g-1; x >=0; x--) {
                bs += this.data[x].characters.length*150 + 300;             // use # of characters for graph spacing
            }
            this.data[g].baseline = bs;
        }
        baseline = this.data[g].baseline;
        // render character initial state
        for (var i=0; i < characters.length; i++) {
            this.ctx.save();
            this.ctx.fillStyle = characters[i].color;
            this.ctx.strokeStyle = characters[i].color;
            this.ctx.lineWidth = thickness;
            this.ctx.beginPath();
            var y = baseline + (75*(i + 2) * (i%2 == 0 ? -1 : 1)) + this.translate.y;

            this.ctx.arc((100+this.translate.x)/this.zoom, y/this.zoom, 10, 0, 2*Math.PI);
            this.ctx.closePath();
            this.ctx.fill();

            this.ctx.save();
            this.ctx.textAlign = "right";
            this.ctx.font = "12pt Arial";
            this.ctx.fillText(characters[i].name, (75 + this.translate.x)/this.zoom, (y+5)/this.zoom);
            this.ctx.restore();

            this.ctx.beginPath();
            this.ctx.moveTo((100+this.translate.x)/this.zoom, y/this.zoom);

            // render each event
            for (var e=0; e < nodes.getNumberOfRows(); e++) {
                var initialX = 4*this.defaultNodeSpacing;
                // if they are involved, render near the baseline, if not, render along their y
                if (nodes.getFormattedValue(e,key["Character Driver"]) != "" && nodes.getFormattedValue(e,key["Character Driver"]) == characters[i].name || (nodes.getFormattedValue(e,key["Characters Involved"]) != "" && nodes.getFormattedValue(e,key["Characters Involved"]).split(",").indexOf(characters[i].name) > -1)) {
                    this.ctx.lineTo((initialX + e*nodeSpacing + this.translate.x)/this.zoom, (baseline + this.translate.y + (3*(i + 2) * (i%2 == 0 ? -1 : 1)))/this.zoom);
                } else {
                    this.ctx.lineTo((initialX + e*nodeSpacing + this.translate.x)/this.zoom, y/this.zoom);
                }
            }
            this.ctx.stroke();
            this.ctx.closePath();
            this.ctx.restore();
        }

        // draw dots last, to as to not screw up canvas lines
        for (var i=0; i < nodes.getNumberOfRows(); i++) {
            if (nodes.getFormattedValue(i,key["EventType"]) == "Character-Driven" && nodes.getFormattedValue(i,key["Character Driver"]) != "") {
                var drawn = false;
                for (var c=0; c < characters.length; c++) {
                    if (nodes.getFormattedValue(i,key["Character Driver"]) == characters[c].name) {
                        this.ctx.save();
                        this.ctx.fillStyle = characters[c].color
                        this.ctx.beginPath();
                        this.ctx.arc((initialX + i*nodeSpacing + this.translate.x)/this.zoom, (baseline + this.translate.y)/this.zoom, (nodes.getFormattedValue(i,key["Importance"]) === "Kernel") ? 15/this.zoom : 8/this.zoom, 0, Math.PI*2);
                        this.ctx.closePath();
                        this.ctx.fill();
                        this.ctx.restore();
                        drawn = true;
                        break;
                    }
                }
                if (!drawn) {
                    // if we reach this point, no character matches.. which shouldn't happen if the data is well formed. Draw a light gray dot to indicate the error
                    this.ctx.save();
                    this.ctx.fillStyle = "#ddd";
                    this.ctx.beginPath();
                    this.ctx.arc((initialX + i*nodeSpacing + this.translate.x)/this.zoom, (baseline + this.translate.y)/this.zoom, (nodes.getFormattedValue(i,key["Importance"]) === "Kernel") ? 12: 7, 0, Math.PI*2);
                    this.ctx.closePath();
                    this.ctx.fill();
                    this.ctx.restore();
                }
            } else {
                this.ctx.save();
                this.ctx.fillStyle = "#111";
                this.ctx.beginPath();
                this.ctx.arc((initialX + i*nodeSpacing + this.translate.x)/this.zoom, (baseline + this.translate.y)/this.zoom, (nodes.getFormattedValue(i,key["Importance"]) === "Kernel") ? 15/this.zoom : 8/this.zoom, 0, Math.PI*2);
                this.ctx.closePath();
                this.ctx.fill();
                this.ctx.restore();
            }
        }
        if (this.data.length > 1) {
            this.ctx.save();
            this.ctx.strokeStyle = "#000";
            this.ctx.lineWidth = 3;
            this.ctx.beginPath();
            this.ctx.moveTo(0, (baseline + this.translate.y + (characters.length + 2)*75)/this.zoom);
            this.ctx.lineTo(4000, (baseline + this.translate.y + (characters.length + 2)*75)/this.zoom);
            this.ctx.closePath();
            this.ctx.stroke();
            this.ctx.restore();
        }
    }
    
    if (this.infoHook != null && (this.infoHook.i >= 0 && this.infoHook.i < this.data[this.infoHook.graph].nodes.getNumberOfRows()))
        this.renderCIInformation(arc);
}
Renderer.prototype.renderCIInformation = function(arc) {
    // parse / wrap text
    var headers = [],
        lines = [],
        data = this.data[this.infoHook.graph]
        ind = this.infoHook.i,
        nodeSpacing = (this.normalize ? this.longestGraphLength / data.nodes.getNumberOfRows() : this.defaultNodeSpacing);
    
    // baseline must take into account heights of all graphs before it
    var baseline = this.data[this.infoHook.graph].characters.length*75 + 150;
    for (var x = this.infoHook.graph-1; x >=0; x--) {
        baseline += this.data[x].characters.length*150 + 300;             // use # of characters for graph spacing
    }
    
    if (arc) {
        headers.push("- " + data.nodes.getFormattedValue(ind,data.key["Arc"]) + " Arc");
    }
    headers.push("- " + data.nodes.getFormattedValue(ind,data.key["Importance"]));
    headers.push("- " + data.nodes.getFormattedValue(ind,data.key["EventType"]));
    if (data.nodes.getFormattedValue(ind,data.key["Character Driver"]) != "")
        headers.push("- Character Driver: " + data.nodes.getFormattedValue(ind,data.key["Character Driver"]));
    headers.push("- Involved characters: ");
    
    lines = this.wrapText(data.nodes.getFormattedValue(ind,data.key["EventDescription"]));
    if (data.nodes.getFormattedValue(ind,data.key["Characters Involved"]) != "") {
        var chars = data.nodes.getFormattedValue(ind,data.key["Characters Involved"]).split(",");
        lines.unshift(" ");
        for (var c= chars.length-1; c >=0; c--) {
            lines.unshift(" - " + chars[c]);
        }
    }
    var actualX = (4*this.defaultNodeSpacing + ind*nodeSpacing + this.translate.x)/this.zoom;
    this.ctx.save();
    this.ctx.translate(actualX, (baseline + this.translate.y)/ this.zoom);
    this.ctx.fillStyle = '#eee';
    var width = ($('canvas').width() - actualX > 300) ? 300 : -300;
    this.ctx.save();
    this.ctx.shadowColor = '#000';
    for (var c=0; c < data.characters.length; c++) {
        if (data.nodes.getFormattedValue(ind,data.key["Character Driver"]) == data.characters[c].name) {
            this.ctx.shadowColor = data.characters[c].color;
            break;
        }
    }
    this.ctx.shadowBlur = 10;
    this.ctx.shadowOffsetY = 2;
    this.ctx.beginPath();
    this.ctx.rect(0,25,width,lines.length*17 + 30 + headers.length*20);
    this.ctx.closePath();
    this.ctx.lineWidth = 3;
    this.ctx.strokeStyle = this.ctx.shadowColor;
    this.ctx.stroke();
    this.ctx.fill();
    this.ctx.restore();
    
    
    // Render information
    this.ctx.save();
    this.ctx.font = "18px Arial";
    this.ctx.fillStyle = "#666";
    this.ctx.shadowColor = "#ccc";
    this.ctx.shadowBlur = 4;
    for (var i=0; i < headers.length; i++)
        this.ctx.fillText(headers[i], ($('canvas').width() - actualX > 300) ? 10 : -290, 50 + 20*i);
    this.ctx.restore();
    
    this.ctx.font = "14px Arial";
    this.ctx.fillStyle = "#333";
    for (var i=0; i < lines.length; i++)
        this.ctx.fillText(lines[i], ($('canvas').width() - actualX > 300) ? 10 : -290, 61 + (17*i) + (20*headers.length));
    this.ctx.restore();
}

Renderer.prototype.wrapText = function(text) {
    var lines = [],
        line = '';
        words = text.split(' ');
    for (var i=0; i < words.length; i++) {
        this.ctx.font = "14px Arial";
        var testLine = line + words[i] + " ";
        var width = this.ctx.measureText(testLine).width;
        if (width > 280 && i > 0) {
            lines.push(line);
            line = words[i] + ' ';
        } else
            line = testLine;
    }
    lines.push(line);
    return lines;
}

Renderer.prototype.zoomGraph = function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.wheelDelta > 0) {
        // zoom in
        // modify translate y and x around mouse wheel
        if (this.zoom > 0.2) {
            this.translate.y -= 15;
            this.translate.x -= 25;
        }
        this.zoom = (Math.max(this.zoom - 0.05, 0.2));
    } else if (e.wheelDelta < 0) {
        // zoom out
        if (this.zoom < 3) {
            this.translate.y += 15;
            this.translate.x += 25;
        }
        this.zoom = (Math.min(this.zoom + 0.05, 5));
    }
}

Renderer.prototype.panGraph = function(e) {
    this.translate.x = this.translate.x + (e.screenX - this.mouseDown.x)*this.zoom;
    this.translate.y = this.translate.y + (e.screenY - this.mouseDown.y)*this.zoom;
    this.mouseDown = {x:e.screenX, y: e.screenY}
}

Renderer.prototype.moveMouse = function(e) {
    // if mouse is pressed down, pan graph
    if (this.mouseDown != null)
        this.panGraph(e);
    
    var initialX = 150; // deprecated... shouldn't be hard coded if can avoid
    
    // else, see if mouse is hovering near an event
    var y = e.offsetY*this.zoom - this.translate.y;

    // check against all baselines
    for (var i=0; i < this.data.length; i++) {
        var nodeSpacing = (this.normalize ? this.longestGraphLength / this.data[i].nodes.getNumberOfRows() : this.defaultNodeSpacing);
        // modify the x to account for the difference in node spacing
        // the graphs don't start at x: 0 so there is a difference from the start of the graph that must be compensated for
        var x = (e.offsetX*this.zoom - this.translate.x) + 4*(nodeSpacing - this.defaultNodeSpacing);
        if (Math.abs(y - this.data[i].baseline) < 15) {
            if (x % nodeSpacing < 15 || x % nodeSpacing > nodeSpacing - 15) {
                // find out which one it corresponds to
                if (this.data[i] != undefined) {
                    this.infoHook = {
                        graph: i,
                        i: Math.round(x/nodeSpacing)-1 - initialX/this.defaultNodeSpacing
                    }
                }
            } else {
                this.infoHook = null;
            }
            break;
        } else {
            this.infoHook = null;
        }
    }
    
}

Renderer.prototype.mouseClick = function(e) {
    if (e.offsetY > 12 && e.offsetY < 35 ) {
        if (e.offsetX > 22 && e.offsetX < 185 && this.graphType == "arc")
            this.showNarrativeStructures = !this.showNarrativeStructures;
        else if (e.offsetX > this.ctx.canvas.width - 170 && e.offsetX < this.ctx.canvas.width - 10)
            this.normalize = !this.normalize;
    }
}

Renderer.prototype.ellipse = function(cx, cy, rx, ry){
    this.ctx.save(); // save state
    this.ctx.beginPath();

    this.ctx.translate((cx-rx+ this.translate.x)/this.zoom, (cy-ry+ this.translate.y)/this.zoom);
    this.ctx.scale(rx/this.zoom, ry/this.zoom);
    this.ctx.arc(1, 1, 1, Math.PI, 2 * Math.PI, false);

    this.ctx.restore(); // restore to original state
    this.ctx.stroke();
}

Renderer.gameNames = {
    0: "Metal Gear Solid 3: Snake Eater",
    1457986752: "The Last of Us",
    206979247: "Uncharted: Drake's Fortune",
    1759301683: "Final Fantasy X",
    1562626512: "Golden Sun",
    1461322742: "The Legend of Zelda: Ocarina of Time",
    1467986246: "Catherine",
    406526062: "To The Moon",
    1156159208: "Destiny",
    1910139021: "Legendary",
    447892497: "Tactics Ogre: Let Us Cling Together",
    1688909195: "DARK",
    1437258919: "Etrian Odyssey 2 Untold",
    1910981236: "Velvet Assassin",
    893344181: "Fire Emblem Fates: Birthright",
    181371315: "Fire Emblem Fates: Conquest",
    1284131435: "Fire Emblem Fates: Revelations",
    1307730140: "Shadow of Mordor",
    926544296: "Gravity Rush"
}