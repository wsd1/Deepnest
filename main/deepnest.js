/*!
 * Deepnest
 * Licensed under GPLv3
 */

(function (root) {
	'use strict';

	const { ipcRenderer } = require('electron');
	const path = require('path')
	const url = require('url')

	root.DeepNest = new DeepNest();

	function DeepNest() {
		var self = this;

		var svg = null;

		var config = {
			clipperScale: 10000000,
			curveTolerance: 0.3,
			spacing: 0,
			rotations: 4,
			populationSize: 10,
			mutationRate: 10,
			threads: 4,
			placementType: 'gravity',
			mergeLines: true,
			timeRatio: 0.5,
			scale: 72,
			simplify: false
		};

		// list of imported files
		// import: {filename: 'blah.svg', svg: svgroot}
		this.imports = [];

		// list of all extracted parts
		// part: {name: 'part name', quantity: ...}
		this.parts = [];

		// a pure polygonal representation of parts that lives only during the nesting step
		this.partsTree = [];

		this.working = false;

		var GA = null;
		var best = null;
		var workerTimer = null;
		var progress = 0;

		var progressCallback = null;
		var displayCallback = null;
		// a running list of placements
		this.nests = [];

		//step1  点击导入文件时 被调用
		this.importsvg = function (filename, dirpath, svgstring, scalingFactor, dxfFlag) {
			// parse svg
			// config.scale is the default scale, and may not be applied
			// scalingFactor is an absolute scaling that must be applied regardless of input svg contents
			svg = SvgParser.load(dirpath, svgstring, config.scale, scalingFactor);
			svg = SvgParser.clean(dxfFlag);

			if (filename) {
				this.imports.push({
					filename: filename,
					svg: svg
				});
			}

			//从一个svg中 可以加载 若干个 顶层元素 对应的 parts
			var parts = this.getParts(svg.children);
			for (var i = 0; i < parts.length; i++) {
				this.parts.push(parts[i]);
			}

			/* part 类如: 
			{	
				polygontree: {source: 0, children:[poly1,...], id, 0:{x, y}, 1:{x, y},...}, 
				svgelements: [顶层对象svg元素, 子poly对象的svg元素],
				bounds:{x, y, width, height},
				area,
				quantity
			}

			poly类如：{source: 23, children:[poly1,...], parent, id, 0:{x, y}, 1:{x, y},...}
			*/




			// test simplification
			/*for(i=0; i<parts.length; i++){
				var part = parts[i];
				this.renderPolygon(part.polygontree, svg);
				var simple = this.simplifyPolygon(part.polygontree);
				this.renderPolygon(simple, svg, 'active');
				if(part.polygontree.children){
					for(var j=0; j<part.polygontree.children.length; j++){
						var schild = this.simplifyPolygon(part.polygontree.children[j], true);
						//this.renderPolygon(schild, svg, 'active');
					}
				}
				//this.renderPolygon(simple.exterior, svg, 'error');
			}*/
		}

		// debug function
		this.renderPolygon = function (poly, svg, highlight) {
			if (!poly || poly.length == 0) {
				return;
			}
			var polyline = window.document.createElementNS('http://www.w3.org/2000/svg', 'polyline');

			for (var i = 0; i < poly.length; i++) {
				var p = svg.createSVGPoint();
				p.x = poly[i].x;
				p.y = poly[i].y;
				polyline.points.appendItem(p);
			}
			if (highlight) {
				polyline.setAttribute('class', highlight);
			}
			svg.appendChild(polyline);
		}

		// debug function
		this.renderPoints = function (points, svg, highlight) {
			for (var i = 0; i < points.length; i++) {
				var circle = window.document.createElementNS('http://www.w3.org/2000/svg', 'circle');
				circle.setAttribute('r', '5');
				circle.setAttribute('cx', points[i].x);
				circle.setAttribute('cy', points[i].y);
				circle.setAttribute('class', highlight);

				svg.appendChild(circle);
			}
		}

		this.getHull = function (polygon) {
			var points = [];
			//转换格式
			for (var i = 0; i < polygon.length; i++) {
				points.push([polygon[i].x, polygon[i].y]);
			}
			var hullpoints = d3.polygonHull(points);

			if (!hullpoints) {
				return null;
			}

			var hull = [];
			for (i = 0; i < hullpoints.length; i++) {
				hull.push({ x: hullpoints[i][0], y: hullpoints[i][1] });
			}

			return hull;
		}

		// use RDP simplification, then selectively offset
		/*  该函数处理优化线条的操作 比较牛批~ 
		in(polygon)  clean => out(cleaned)
		in(polygon)  copy => simplify(copy) 边长度优先 => cleanPolygon(simple) => 
					 polygonOffset(simple) => 外壳offset  or 内孔holes
					 simple 顶点标记 exact
					 simple 以config.curveTolerance为间距 外延（或内缩）构造 3个“壳” => shells
		*/
		this.simplifyPolygon = function (polygon, inside) {
			var tolerance = 4 * config.curveTolerance;

			// give special treatment to line segments above this length (squared)
			var fixedTolerance = 40 * config.curveTolerance * 40 * config.curveTolerance;
			var i, j, k;
			var self = this;

			//如果 配置 外轮廓替代
			if (config.simplify) {
				/*
				// use convex hull
				var hull = new ConvexHullGrahamScan();
				for(var i=0; i<polygon.length; i++){
					hull.addPoint(polygon[i].x, polygon[i].y);
				}
			
				return hull.getHull();*/
				var hull = this.getHull(polygon);
				if (hull) {
					return hull;
				}
				else {
					return polygon;
				}
			}

			var cleaned = this.cleanPolygon(polygon);
			if (cleaned && cleaned.length > 1) {
				polygon = cleaned;
			}
			else {
				return polygon;
			}


			//到这里 输出了 clean






			//polygon不用包括最后一个首相同点 polyline需要，这就是区别
			// polygon to polyline
			var copy = polygon.slice(0);
			copy.push(copy[0]);

			// mark all segments greater than ~0.25 in to be kept
			// the PD simplification algo doesn't care about the accuracy of long lines, only the absolute distance of each point
			// we care a great deal
			//下面在线条中 足够长（config.curveTolerance * 40）的线段curveTolerance为0.1时，这个上限是4mm。
			//线段顶点标记 marked 
			for (i = 0; i < copy.length - 1; i++) {
				var p1 = copy[i];
				var p2 = copy[i + 1];
				var sqd = (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);
				if (sqd > fixedTolerance) {
					p1.marked = true;
					p2.marked = true;
				}
			}

			//上面给相对长的多边形边做了标记，下面的simplify代码里面 作者添加了自己的逻辑，
			//遇到marked端点会跳过检测，因此，都会得到保留
			var simple = window.simplify(copy, tolerance, true);
			// now a polygon again
			simple.pop(); //将最后一个 首点重复的尾点 去除。转回 polygon

			// could be dirty again (self intersections and/or coincident points)
			simple = this.cleanPolygon(simple);

			// simplification process reduced poly to a line or point
			//也有可能将polygon 简化成一条线，那就恢复原样
			if (!simple) {
				simple = polygon;
			}


			//根据 内外 构造 收缩 或 扩张 轮廓
			var offsets = this.polygonOffset(simple, inside ? -tolerance : tolerance);

			var offset = null;
			var offsetArea = 0;
			var holes = [];

			//下面从offsets 找最大的轮廓 offset (负数表示逆时针 是外扩框)
			//或者 收集所有的内孔到 holes
			for (i = 0; i < offsets.length; i++) {
				var area = GeometryUtil.polygonArea(offsets[i]);
				if (offset == null || area < offsetArea) {
					offset = offsets[i];
					offsetArea = area; //更新最小值
				}
				//正面积 表示是顺时针 内孔 收集所有孔。这时offset为最小孔
				if (area > 0) {
					holes.push(offsets[i]);
				}
			}







			//为 simple 顶点标记 exact
			//大致意思是 simple之后的多边形，若其某边与源polygon的边重合，那么两个端点（顶点）标记为 exact
			// 只有simplify过程中 间隔消除顶点，形成孤悬在两个消除点之间的 保留点，才会是 exact:false。
			// mark any points that are exact
			for (i = 0; i < simple.length; i++) {
				var seg = [simple[i], simple[i + 1 == simple.length ? 0 : i + 1]];
				var index1 = find(seg[0], polygon); //分别找线段的两端
				var index2 = find(seg[1], polygon);

				if (index1 + 1 == index2 || index2 + 1 == index1 || (index1 == 0 && index2 == polygon.length - 1) || (index2 == 0 && index1 == polygon.length - 1)) {
					seg[0].exact = true;
					seg[1].exact = true;
				}

			}


			//以config.curveTolerance为间距 simple 外延（内缩）构造 3个“壳” shells[]内
			var numshells = 4;
			var shells = [];

			for (j = 1; j < numshells; j++) {
				var delta = j * (tolerance / numshells);
				delta = inside ? -delta : delta;
				var shell = this.polygonOffset(simple, delta);
				if (shell.length > 0) {
					shell = shell[0]; //这里只取首个offset
				}
				shells[j] = shell;  //注意  shells[0] 是空的
			}











			//又回到 为simple生成的 外扩轮廓 offset ，比较奇怪，这段代码位置 应该放在上面
			// offset是上面找到的最大的外轮廓
			if (!offset) {
				return polygon;
			}

			// selective reversal of offset 
			// 遍历所有外轮廓的顶点，调整，使之靠近源polygon
			for (i = 0; i < offset.length; i++) {
				var o = offset[i];
				//遍历所有外轮廓的顶点
				//在simple线条中 找出距离指定point 最近的 顶点（最好是标记 exact的）
				var target = getTarget(o, simple, 2 * tolerance);

				// reverse point offset and try to find exterior points
				//这是让 外轮廓 当前顶点  改为simple线条上最近顶点
				var test = clone(offset);
				test[i] = { x: target.x, y: target.y }; 
				//上面的动作比较考验想象力：
				//polygon simplify之后产生 simple线条；polygon外扩或内缩产生 offset线条；
				// 将offset线条上的一个点，改动为距离该点最近的 simple上的一个点上 ，
				// 然后检查这个形状是否干涉到了原形状 polygon，即，(polygon上有顶点超出了这个测试多边形test以外)
				if (!exterior(test, polygon, inside)) {
					//如果干涉原形状，那么改动保持
					o.x = target.x;
					o.y = target.y;
				}
				else {
					//否则 其会再去从 前面构造的 三层外扩轮廓shells（由近及远的） 找点
					// a shell is an intermediate offset between simple and offset
					for (j = 1; j < numshells; j++) {
						if (shells[j]) {
							var shell = shells[j];
							var delta = j * (tolerance / numshells);
							target = getTarget(o, shell, 2 * delta);
							var test = clone(offset);
							test[i] = { x: target.x, y: target.y };
							if (!exterior(test, polygon, inside)) {
								o.x = target.x;
								o.y = target.y;
								break;
							}
						}
					}
				}
			}


			//上面的逻辑 让我目瞪口呆的体会了一种精细的调整多边形的过程

			//offset轮廓，不停调整顶点，尽可能的向贴近polygon的方向靠近。
			//同样的逻辑也适用于 内孔的处理。



			//为什么这样做！！！！！！！！？？？？？？？？
			//这个逻辑可以解决 simplify过程可能产生的 顶点消除导致 收缩效应
			// 外扩 可以保证所有线条都在源polygon以外；
			// 内缩 可以保证，所有线条都在polygon以内；















			// straighten long lines
			// a rounded rectangle would still have issues at this point, as the long sides won't line up straight

			var straightened = false;

			for (i = 0; i < offset.length; i++) {
				var p1 = offset[i];
				var p2 = offset[i + 1 == offset.length ? 0 : i + 1];

				var sqd = (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);

				if (sqd < fixedTolerance) {
					continue;
				}
				for (j = 0; j < simple.length; j++) {
					var s1 = simple[j];
					var s2 = simple[j + 1 == simple.length ? 0 : j + 1];

					//这里可能有问题  应该是 s1 s2 算距离
					var sqds = (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);

					if (sqds < fixedTolerance) {
						continue;
					}

					if ((GeometryUtil.almostEqual(s1.x, s2.x) || GeometryUtil.almostEqual(s1.y, s2.y)) && // we only really care about vertical and horizontal lines
						GeometryUtil.withinDistance(p1, s1, 2 * tolerance) &&
						GeometryUtil.withinDistance(p2, s2, 2 * tolerance) &&
						(!GeometryUtil.withinDistance(p1, s1, config.curveTolerance / 1000) ||
							!GeometryUtil.withinDistance(p2, s2, config.curveTolerance / 1000))) {
						p1.x = s1.x;
						p1.y = s1.y;
						p2.x = s2.x;
						p2.y = s2.y;
						straightened = true;
					}
				}
			}

			//if(straightened){
			var Ac = toClipperCoordinates(offset);
			ClipperLib.JS.ScaleUpPath(Ac, 10000000);
			var Bc = toClipperCoordinates(polygon);
			ClipperLib.JS.ScaleUpPath(Bc, 10000000);

			var combined = new ClipperLib.Paths();
			var clipper = new ClipperLib.Clipper();

			clipper.AddPath(Ac, ClipperLib.PolyType.ptSubject, true);
			clipper.AddPath(Bc, ClipperLib.PolyType.ptSubject, true);

			// the line straightening may have made the offset smaller than the simplified
			if (clipper.Execute(ClipperLib.ClipType.ctUnion, combined, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) {
				var largestArea = null;
				for (i = 0; i < combined.length; i++) {
					var n = toNestCoordinates(combined[i], 10000000);
					var sarea = -GeometryUtil.polygonArea(n);
					if (largestArea === null || largestArea < sarea) {
						offset = n;
						largestArea = sarea;
					}
				}
			}
			//}

			cleaned = this.cleanPolygon(offset);
			if (cleaned && cleaned.length > 1) {
				offset = cleaned;
			}

			// mark any points that are exact (for line merge detection)
			for (i = 0; i < offset.length; i++) {
				var seg = [offset[i], offset[i + 1 == offset.length ? 0 : i + 1]];
				var index1 = find(seg[0], polygon);
				var index2 = find(seg[1], polygon);

				if (index1 + 1 == index2 || index2 + 1 == index1 || (index1 == 0 && index2 == polygon.length - 1) || (index2 == 0 && index1 == polygon.length - 1)) {
					seg[0].exact = true;
					seg[1].exact = true;
				}
			}

			//如果不是向内收缩 但是又产生了hole，奇怪？
			if (!inside && holes && holes.length > 0) {
				offset.children = holes;
				console.error("怪怪怪，外扩却产生了孔，请详细深入。");
			}

			return offset;

			//在simple线条中 找出距离指定point 最近的 顶点（最好是标记 exact的）
			function getTarget(point, simple, tol) {
				var inrange = [];

				//找线条中距离指定point足够接近的 顶点，{ point, distance }
				// find closest points within 2 offset deltas
				for (var j = 0; j < simple.length; j++) {
					var s = simple[j];
					var d2 = (o.x - s.x) * (o.x - s.x) + (o.y - s.y) * (o.y - s.y);
					if (d2 < tol * tol) {
						inrange.push({ point: s, distance: d2 });
					}
				}

				var target;

				//如果有找到 那就过滤下 只选取那些 simplify优化后依然存在的顶点
				if (inrange.length > 0) {
					var filtered = inrange.filter(function (p) {
						return p.point.exact;
					});

					//都不满足条件，那就继续使用原结果
					// use exact points when available, normal points when not
					inrange = filtered.length > 0 ? filtered : inrange;

					//按照距离排序
					inrange.sort(function (a, b) {
						return a.distance - b.distance;
					});
					//target就是最近的那个顶点
					target = inrange[0].point;
				}
				else {//否则就去找 距离点最近的那个 vertex
					var mind = null;
					for (j = 0; j < simple.length; j++) {
						var s = simple[j];
						var d2 = (o.x - s.x) * (o.x - s.x) + (o.y - s.y) * (o.y - s.y);
						if (mind === null || d2 < mind) {
							target = s;
							mind = d2;
						}
					}
				}

				return target;
			}

			// returns true if any complex vertices fall outside the simple polygon
			//遍历complex的所有顶点，检查是否超出simple形状（向内 或 向外）
			function exterior(simple, complex, inside) {
				// find all protruding vertices

				//对每一个 complex的 顶点
				for (var i = 0; i < complex.length; i++) {
					var v = complex[i];

					//向外检查时， complex 上只要有一个顶点  不在simple形状内 也不在simple边上，就返回越界
					if (!inside && !self.pointInPolygon(v, simple) && find(v, simple) === null) {
						return true;
					}

					//向内检查时 只要有一个顶点在 simple形状内 或者在边上，那就是越界了
					if (inside && self.pointInPolygon(v, simple) && !find(v, simple) === null) {
						return true;
					}
				}
				return false;
			}

			function toClipperCoordinates(polygon) {
				var clone = [];
				for (var i = 0; i < polygon.length; i++) {
					clone.push({
						X: polygon[i].x,
						Y: polygon[i].y
					});
				}

				return clone;
			};

			function toNestCoordinates(polygon, scale) {
				var clone = [];
				for (var i = 0; i < polygon.length; i++) {
					clone.push({
						x: polygon[i].X / scale,
						y: polygon[i].Y / scale
					});
				}

				return clone;
			};

			//从polygon中找出顶点v（极度靠近也可以）
			function find(v, p) {
				for (var i = 0; i < p.length; i++) {
					if (GeometryUtil.withinDistance(v, p[i], config.curveTolerance / 1000)) {
						return i;
					}
				}
				return null;
			}

			//遍历复制 {x,y}
			function clone(p) {
				var newp = [];
				for (var i = 0; i < p.length; i++) {
					newp.push({
						x: p[i].x,
						y: p[i].y
					});
				}

				return newp;
			}
		}

		this.config = function (c) {
			// clean up inputs

			if (!c) {
				return config;
			}

			if (c.curveTolerance && !GeometryUtil.almostEqual(parseFloat(c.curveTolerance), 0)) {
				config.curveTolerance = parseFloat(c.curveTolerance);
			}

			if ('spacing' in c) {
				config.spacing = parseFloat(c.spacing);
			}

			if (c.rotations && parseInt(c.rotations) > 0) {
				config.rotations = parseInt(c.rotations);
			}

			if (c.populationSize && parseInt(c.populationSize) > 2) {
				config.populationSize = parseInt(c.populationSize);
			}

			if (c.mutationRate && parseInt(c.mutationRate) > 0) {
				config.mutationRate = parseInt(c.mutationRate);
			}

			if (c.threads && parseInt(c.threads) > 0) {
				// max 8 threads
				config.threads = Math.min(parseInt(c.threads), 8);
			}

			if (c.placementType) {
				config.placementType = String(c.placementType);
			}

			if (c.mergeLines === true || c.mergeLines === false) {
				config.mergeLines = !!c.mergeLines;
			}

			if (c.simplify === true || c.simplify === false) {
				config.simplify = !!c.simplify;
			}

			var n = Number(c.timeRatio);
			if (typeof n == 'number' && !isNaN(n) && isFinite(n)) {
				config.timeRatio = n;
			}

			if (c.scale && parseInt(c.scale) > 0) {
				config.scale = parseInt(c.scale);
			}

			SvgParser.config({ tolerance: config.curveTolerance, endpointTolerance: c.endpointTolerance });

			best = null;
			//nfpCache = {};
			//binPolygon = null;
			GA = null;

			return config;
		}

		this.pointInPolygon = function (point, polygon) {
			// scaling is deliberately coarse to filter out points that lie *on* the polygon
			var p = this.svgToClipper(polygon, 1000);
			var pt = new ClipperLib.IntPoint(1000 * point.x, 1000 * point.y);

			return ClipperLib.Clipper.PointInPolygon(pt, p) > 0;
		}

		/*this.simplifyPolygon = function(polygon, concavehull){
			function clone(p){
				var newp = [];
				for(var i=0; i<p.length; i++){
					newp.push({
						x: p[i].x,
						y: p[i].y
						//fuck: p[i].fuck
					});
				}
				return newp;
			}
			if(concavehull){
				var hull = concavehull;
			}
			else{
				var hull = new ConvexHullGrahamScan();
				for(var i=0; i<polygon.length; i++){
					hull.addPoint(polygon[i].x, polygon[i].y);
				}
			
				hull = hull.getHull();
			}
			
			var hullarea = Math.abs(GeometryUtil.polygonArea(hull));
			
			var concave = [];
			var detail = [];
			
			// fill concave[] with convex points, ensuring same order as initial polygon
			for(i=0; i<polygon.length; i++){
				var p = polygon[i];
				var found = false;
				for(var j=0; j<hull.length; j++){
					var hp = hull[j];
					if(GeometryUtil.almostEqual(hp.x, p.x) && GeometryUtil.almostEqual(hp.y, p.y)){
						found = true;
						break;
					}
				}
				
				if(found){
					concave.push(p);
					//p.fuck = i+'yes';
				}
				else{
					detail.push(p);
					//p.fuck = i+'no';
				}
			}
			
			var cindex = -1;
			var simple = [];
			
			for(i=0; i<polygon.length; i++){
				var p = polygon[i];
				if(concave.indexOf(p) > -1){
					cindex = concave.indexOf(p);
					simple.push(p);
				}
				else{
					
					var test = clone(concave);
					test.splice(cindex < 0 ? 0 : cindex+1,0,p);
					
					var outside = false;
					for(var j=0; j<detail.length; j++){
						if(detail[j] == p){
							continue;
						}
						if(!this.pointInPolygon(detail[j], test)){
							//console.log(detail[j], test);
							outside = true;
							break;
						}
					}
					
					if(outside){
						continue;
					}
					
					var testarea =  Math.abs(GeometryUtil.polygonArea(test));
					//console.log(testarea, hullarea);
					if(testarea/hullarea < 0.98){
						simple.push(p);
					}
				}
			}
			
			return simple;
		}*/


		// assuming no intersections, return a tree where odd leaves are parts and even ones are holes
		// might be easier to use the DOM, but paths can't have paths as children. So we'll just make our own tree.
		//此段代码 被 importsvg 使用
		this.getParts = function (paths) { //paths是svg的元素对象

			var i, j;
			var polygons = [];

			var numChildren = paths.length;
			for (i = 0; i < numChildren; i++) {

				//导入的path 必须是如下其中之一： 0:"svg" 1:"circle" 2:"ellipse" 3:"path" 4:"polygon" 5:"polyline" 6:"rect"
				if (SvgParser.polygonElements.indexOf(paths[i].tagName) < 0) {
					continue;
				}

				//跳过开放的线条
				if (!SvgParser.isClosed(paths[i], 2 * config.curveTolerance)) {
					continue;
				}

				//线段化  返回 [{x, y},...]
				var poly = SvgParser.polygonify(paths[i]);

				//去除线段交叉，找出最大多边形，去除相同点
				poly = this.cleanPolygon(poly);

				// todo: warn user if poly could not be processed and is excluded from the nest
				if (poly && poly.length > 2 && Math.abs(GeometryUtil.polygonArea(poly)) > config.curveTolerance * config.curveTolerance) {
					poly.source = i;
					polygons.push(poly); //现在 poly是 [source: 0, 0:{x, y}, 1:{x, y},...]
				}
			}

			//polygons是对应于 线条元素的数组 形如： [poly1, poly2, ...]， poly类如： [source: 0, 0:{x, y}, 1:{x, y},...]

			// turn the list into a tree
			// root level nodes of the tree are parts
			toTree(polygons);

			function toTree(list, idstart) {
				function svgToClipper(polygon) {
					var clip = [];
					for (var i = 0; i < polygon.length; i++) {
						clip.push({ X: polygon[i].x, Y: polygon[i].y });
					}

					ClipperLib.JS.ScaleUpPath(clip, config.clipperScale);

					return clip;
				}
				function pointInClipperPolygon(point, polygon) {
					var pt = new ClipperLib.IntPoint(config.clipperScale * point.x, config.clipperScale * point.y);

					return ClipperLib.Clipper.PointInPolygon(pt, polygon) > 0;
				}
				var parents = [];
				var i, j, k;
				//list 是对应于 线条元素的数组 形如： [poly1, poly2, ...]， poly类如： [source: 0, 0:{x, y}, 1:{x, y},...]

				// assign a unique id to each leaf
				var id = idstart || 0;

				//下面两个嵌套的循环，将list中的poly（[source: 0, 0:{x, y}, 1:{x, y},...]）对象，做包含检测。
				//并将其树状化，顶层元素放入parents[]数组中
				for (i = 0; i < list.length; i++) {
					var p = list[i]; // p 类如： [source: 0, 0:{x, y}, 1:{x, y},...]

					//外循环的对象 检测是否是 内循环对象的 child
					var ischild = false;
					for (j = 0; j < list.length; j++) {
						if (j == i) {
							continue;
						}
						if (p.length < 2) {
							continue;
						}
						var inside = 0;
						var fullinside = Math.min(10, p.length);

						// sample about 10 points
						var clipper_polygon = svgToClipper(list[j]);

						for (k = 0; k < fullinside; k++) {
							if (pointInClipperPolygon(p[k], clipper_polygon) === true) {
								inside++;
							}
						}

						//console.log(inside, fullinside);

						if (inside > 0.5 * fullinside) {
							if (!list[j].children) {
								list[j].children = [];
							}
							list[j].children.push(p);
							p.parent = list[j];
							ischild = true;
							break;
						}
					}

					if (!ischild) {
						parents.push(p);
					}
				}

				//清理 list 只留下顶层元素
				for (i = 0; i < list.length; i++) {
					if (parents.indexOf(list[i]) < 0) {
						list.splice(i, 1);
						i--;
					}
				}

				//所有 顶层对象 设定 增序的 id
				for (i = 0; i < parents.length; i++) {
					parents[i].id = id;
					id++;
				}

				for (i = 0; i < parents.length; i++) {
					if (parents[i].children) {
						//递归 整理每一个顶层元素内部的 秩序（会）
						id = toTree(parents[i].children, id);
					}
				}

				return id;
			};


			//这里 polygons 仅剩下顶层元素，结构类如  [TopPoly1, TopPoly2, ...]
			//TopPoly类如：{source: 0, children:[poly1,...], id, 0:{x, y}, 1:{x, y},...}
			//非顶层poly 类如：
			//{source: 0, children:[poly1,...], parent, id, 0:{x, y}, 1:{x, y},...}

			// construct part objects with metadata
			var parts = [];
			var svgelements = Array.prototype.slice.call(paths);   //这样使用 主要是 paths 不是数组，其实为 类数组对象，其含有 length成员和 数字索引的成员
			var openelements = svgelements.slice(); // elements that are not a part of the poly tree but may still be a part of the part (images, lines, possibly text..)

			//对每一个 顶层 poly对象，添加原先的svg元素，并且从 openelements 删除svg元素，最终openelements留下没有 被挑选为 封闭poly 的svg对象（开放线条，text什么的） 
			for (i = 0; i < polygons.length; i++) {
				var part = {};
				part.polygontree = polygons[i];
				part.svgelements = [];

				var bounds = GeometryUtil.getPolygonBounds(part.polygontree);
				part.bounds = bounds;
				part.area = bounds.width * bounds.height;
				part.quantity = 1;

				// load root element  加入自己的  svg元素，并从 openelements 剔除之
				part.svgelements.push(svgelements[part.polygontree.source]);
				var index = openelements.indexOf(svgelements[part.polygontree.source]);
				if (index > -1) {
					openelements.splice(index, 1);
				}


				//下面将 子poly 对象 对应的 svg元素，加入到 顶层poly对象的 svgelements数组中，
				// 并从 openelements 剔除之

				// load all elements that lie within the outer polygon
				for (j = 0; j < svgelements.length; j++) {
					if (j != part.polygontree.source && findElementById(j, part.polygontree)) {
						part.svgelements.push(svgelements[j]);
						index = openelements.indexOf(svgelements[j]);
						if (index > -1) {
							openelements.splice(index, 1);
						}
					}
				}

				//最终openelements留下没有 被挑选为 封闭poly 的svg对象（开放线条，text什么的） 


				/* part 类如: 
				{	
					polygontree: {source: 0, children:[poly1,...], id, 0:{x, y}, 1:{x, y},...}, 
					svgelements: [顶层对象svg元素, 子poly对象的svg元素],
					bounds:{x, y, width, height},
					area,
					quantity
				}

				poly类如：{source: 23, children:[poly1,...], parent, id, 0:{x, y}, 1:{x, y},...}
				*/

				parts.push(part);
			}

			function findElementById(id, tree) {
				if (id == tree.source) {
					return true;
				}

				if (tree.children && tree.children.length > 0) {
					for (var i = 0; i < tree.children.length; i++) {
						if (findElementById(id, tree.children[i])) {
							return true;
						}
					}
				}

				return false;
			}

			for (i = 0; i < parts.length; i++) {
				var part = parts[i];
				// the elements left are either erroneous or open
				// we want to include open segments that also lie within the part boundaries
				for (j = 0; j < openelements.length; j++) {
					var el = openelements[j];
					if (el.tagName == 'line') {
						var x1 = Number(el.getAttribute('x1'));
						var x2 = Number(el.getAttribute('x2'));
						var y1 = Number(el.getAttribute('y1'));
						var y2 = Number(el.getAttribute('y2'));
						var start = { x: x1, y: y1 };
						var end = { x: x2, y: y2 };
						var mid = { x: ((start.x + end.x) / 2), y: ((start.y + end.y) / 2) };

						if (this.pointInPolygon(start, part.polygontree) === true ||
							this.pointInPolygon(end, part.polygontree) === true ||
							this.pointInPolygon(mid, part.polygontree) === true) {
							part.svgelements.push(el);
							openelements.splice(j, 1);
							j--;
						}
					}
					else if (el.tagName == 'image') {
						var x = Number(el.getAttribute('x'));
						var y = Number(el.getAttribute('y'));
						var width = Number(el.getAttribute('width'));
						var height = Number(el.getAttribute('height'));

						var mid = { x: x + (width / 2), y: y + (height / 2) };

						var transformString = el.getAttribute('transform')
						if (transformString) {
							var transform = SvgParser.transformParse(transformString);
							if (transform) {
								var transformed = transform.calc(mid.x, mid.y);
								mid.x = transformed[0];
								mid.y = transformed[1];
							}
						}
						// just test midpoint for images
						if (this.pointInPolygon(mid, part.polygontree) === true) {
							part.svgelements.push(el);
							openelements.splice(j, 1);
							j--;
						}
					}
					else if (el.tagName == 'path' || el.tagName == 'polyline') {
						var k;
						if (el.tagName == 'path') {
							var p = SvgParser.polygonifyPath(el);
						}
						else {
							var p = [];
							for (k = 0; k < el.points.length; k++) {
								p.push({
									x: el.points[k].x,
									y: el.points[k].y
								});
							}
						}

						if (p.length < 2) {
							continue;
						}

						var found = false;
						var next = p[1];
						for (k = 0; k < p.length; k++) {
							if (this.pointInPolygon(p[k], part.polygontree) === true) {
								found = true;
								break;
							}

							if (k >= p.length - 1) {
								next = p[0];
							}
							else {
								next = p[k + 1];
							}

							// also test for midpoints in case of single line edge case
							var mid = {
								x: (p[k].x + next.x) / 2,
								y: (p[k].y + next.y) / 2
							};
							if (this.pointInPolygon(mid, part.polygontree) === true) {
								found = true;
								break;
							}

						}
						if (found) {
							part.svgelements.push(el);
							openelements.splice(j, 1);
							j--;
						}
					}
					else {
						// something went wrong
						//console.log('part not processed: ',el);
					}
				}
			}

			for (j = 0; j < openelements.length; j++) {
				var el = openelements[j];
				if (el.tagName == 'line' || el.tagName == 'polyline' || el.tagName == 'path') {
					el.setAttribute('class', 'error');
				}
			}

			return parts;
		};

		this.cloneTree = function (tree) {
			//只拷贝每一层 的 {children, 0: {x, y, exact}, [1], ...}
			var newtree = [];
			tree.forEach(function (t) {
				newtree.push({ x: t.x, y: t.y, exact: t.exact });
			});

			var self = this;
			if (tree.children && tree.children.length > 0) {
				newtree.children = [];
				tree.children.forEach(function (c) {
					newtree.children.push(self.cloneTree(c));
				});
			}

			return newtree;
		}

		// progressCallback is called when progress is made
		// displayCallback is called when a new placement has been made
		this.start = function (p, d) {
			progressCallback = p;
			displayCallback = d;

			var parts = [];

			/*while(this.nests.length > 0){
				this.nests.pop();
			}*/

			// send only bare essentials through ipc
			for (var i = 0; i < this.parts.length; i++) {

				/* this.parts 数组成员类如: 
				{	
					polygontree: {source: 0, children:[poly1,...], id, 0:{x, y}, 1:{x, y},...}, 
					svgelements: [顶层对象svg元素, 子poly对象的svg元素],
					bounds:{x, y, width, height},
					area,
					quantity
				}
	
				子poly类如：{source: 23, children:[poly1,...], parent, id, 0:{x, y}, 1:{x, y},...}
				*/




				parts.push({
					quantity: this.parts[i].quantity,
					sheet: this.parts[i].sheet,
					polygontree: this.cloneTree(this.parts[i].polygontree)
					//形如： {children, 0: {x, y, exact}, 1，2，3, ...} 点数组 对象 混合体
				});
			}

			for (i = 0; i < parts.length; i++) {
				if (parts[i].sheet) {
					//会直接修改 parts[i].polygontree
					offsetTree(parts[i].polygontree, -0.5 * config.spacing, this.polygonOffset.bind(this), this.simplifyPolygon.bind(this), true);
				}
				else {
					//会直接修改 parts[i].polygontree
					offsetTree(parts[i].polygontree, 0.5 * config.spacing, this.polygonOffset.bind(this), this.simplifyPolygon.bind(this));
				}
			}

			// offset tree recursively
			function offsetTree(t, offset, offsetFunction, simpleFunction, inside) {
				var simple = t; // 形如： {children, 0: {x, y, exact}, 1，2，3, ...} 点数组 对象 混合体

				//simpleFunction(t) => simple
				if (simpleFunction) {
					simple = simpleFunction(t, !!inside);
					//这是个非常复杂的处理流程 包括simplify clean 抽壳渐进收敛 才获取到最接近多边形
					//由于内部有 offset操作，所以可能产生 内孔 simple可能带有 children
				}

				var offsetpaths = [simple];
				if (offset > 0) {
					offsetpaths = offsetFunction(simple, offset);
				}

				//simpleFunction(t) => simple    offsetFunction(simple) => offsetpaths 
				// t的点序列更换上offset产生的点（offsetpaths[0]）（t依然保留其他成员如 source children等）
				if (offsetpaths.length > 0) {
					//var cleaned = cleanFunction(offsetpaths[0]); 

					// 修改传入的参数t，数组成员逐个替换掉 : splice(位置头，长度, 候补1，候补2, ....)
					Array.prototype.splice.apply(t, [0, t.length].concat(offsetpaths[0]));
				}

				// t的children 添加上 simpleFunction()中 产生的孔（由 offset(4 * config.curveTolerance) 过程实施产生 ），加入回t
				if (simple.children && simple.children.length > 0) {
					if (!t.children) {
						t.children = [];
					}
					//t原先可能就带有孔
					for (var i = 0; i < simple.children.length; i++) {
						t.children.push(simple.children[i]);
					}
				}

				//递归处理内部元素 t.children
				//t的孔 包括之前getParts中收集的，和外轮廓实施simpleFunction()产生的
				if (t.children && t.children.length > 0) {
					for (var i = 0; i < t.children.length; i++) {
						offsetTree(t.children[i], -offset, offsetFunction, simpleFunction, !inside);
					}
				}
			}

			var self = this;
			this.working = true;

			if (!workerTimer) {
				workerTimer = setInterval(function () {
					self.launchWorkers.call(self, parts, config, progressCallback, displayCallback);
					//progressCallback(progress);
				}, 100);
			}
		}

		ipcRenderer.on('background-response', (event, payload) => {
			console.log('ipc response', payload);
			if (!GA) {
				// user might have quit while we're away
				return;
			}
			GA.population[payload.index].processing = false;
			GA.population[payload.index].fitness = payload.fitness;

			// render placement
			if (this.nests.length == 0 || this.nests[0].fitness > payload.fitness) {
				this.nests.unshift(payload);

				if (this.nests.length > 10) {
					this.nests.pop();
				}
				if (displayCallback) {
					displayCallback();
				}
			}
		});

		this.launchWorkers = function (parts, config, progressCallback, displayCallback) {
			function shuffle(array) {
				var currentIndex = array.length, temporaryValue, randomIndex;

				// While there remain elements to shuffle...
				while (0 !== currentIndex) {

					// Pick a remaining element...
					randomIndex = Math.floor(Math.random() * currentIndex);
					currentIndex -= 1;

					// And swap it with the current element.
					temporaryValue = array[currentIndex];
					array[currentIndex] = array[randomIndex];
					array[randomIndex] = temporaryValue;
				}

				return array;
			}

			var i, j;

			if (GA === null) {
				// initiate new GA

				var adam = [];
				var id = 0;
				for (i = 0; i < parts.length; i++) {
					if (!parts[i].sheet) {

						for (j = 0; j < parts[i].quantity; j++) {
							var poly = this.cloneTree(parts[i].polygontree); // deep copy
							poly.id = id; // id is the unique id of all parts that will be nested, including cloned duplicates
							poly.source = i; // source is the id of each unique part from the main part list

							adam.push(poly);
							id++;
						}
					}
				}

				// seed with decreasing area
				adam.sort(function (a, b) {
					return Math.abs(GeometryUtil.polygonArea(b)) - Math.abs(GeometryUtil.polygonArea(a));
				});

				GA = new GeneticAlgorithm(adam, config);
				//console.log(GA.population[1].placement);				
			}

			// check if current generation is finished
			var finished = true;
			for (i = 0; i < GA.population.length; i++) {
				if (!GA.population[i].fitness) {
					finished = false;
					break;
				}
			}

			if (finished) {
				console.log('new generation!');
				// all individuals have been evaluated, start next generation
				GA.generation();
			}

			var running = GA.population.filter(function (p) {
				return !!p.processing;
			}).length;


			//这里组织 发给后台处理的 资源
			var sheets = [];
			var sheetids = [];
			var sheetsources = [];
			var sheetchildren = [];
			var sid = 0;
			for (i = 0; i < parts.length; i++) {
				if (parts[i].sheet) {
					var poly = parts[i].polygontree;
					//部件 按照数量 多次加入
					for (j = 0; j < parts[i].quantity; j++) {
						sheets.push(poly);
						sheetids.push(sid);
						sheetsources.push(i);
						sheetchildren.push(poly.children);
						sid++;
					}
				}
			}


			for (i = 0; i < GA.population.length; i++) {
				//if(running < config.threads && !GA.population[i].processing && !GA.population[i].fitness){
				// only one background window now...
				if (running < 1 && !GA.population[i].processing && !GA.population[i].fitness) {
					GA.population[i].processing = true;

					// hash values on arrays don't make it across ipc, store them in an array and reassemble on the other side....
					var ids = [];
					var sources = [];
					var children = [];

					for (j = 0; j < GA.population[i].placement.length; j++) {
						var id = GA.population[i].placement[j].id;
						var source = GA.population[i].placement[j].source;
						var child = GA.population[i].placement[j].children;
						ids[j] = id;
						sources[j] = source;
						children[j] = child;
					}

					ipcRenderer.send('background-start', {
						index: i,
						individual: GA.population[i],
						sheets, sheetids, sheetsources, sheetchildren,
						config, ids, sources, children
					});
					running++;
				}
			}
		}

		// 抽壳操作
		// use the clipper library to return an offset to the given polygon. Positive offset expands the polygon, negative contracts
		// note that this returns an array of polygons
		this.polygonOffset = function (polygon, offset) {
			if (!offset || offset == 0 || GeometryUtil.almostEqual(offset, 0)) {
				return polygon;
			}

			var p = this.svgToClipper(polygon);

			var miterLimit = 4;
			var co = new ClipperLib.ClipperOffset(miterLimit, config.curveTolerance * config.clipperScale);
			co.AddPath(p, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);

			var newpaths = new ClipperLib.Paths();
			co.Execute(newpaths, offset * config.clipperScale);

			var result = [];
			for (var i = 0; i < newpaths.length; i++) {
				result.push(this.clipperToSvg(newpaths[i]));
			}

			return result;
		};

		// returns a less complex polygon that satisfies the curve tolerance
		// 整理线条得到最大简单多边形，并且去掉首尾相同点
		this.cleanPolygon = function (polygon) {
			var p = this.svgToClipper(polygon);
			// remove self-intersections and find the biggest polygon that's left
			var simple = ClipperLib.Clipper.SimplifyPolygon(p, ClipperLib.PolyFillType.pftNonZero);

			if (!simple || simple.length == 0) {
				return null;
			}

			var biggest = simple[0];
			var biggestarea = Math.abs(ClipperLib.Clipper.Area(biggest));
			for (var i = 1; i < simple.length; i++) {
				var area = Math.abs(ClipperLib.Clipper.Area(simple[i]));
				if (area > biggestarea) {
					biggest = simple[i];
					biggestarea = area;
				}
			}

			// clean up singularities, coincident points and edges
			var clean = ClipperLib.Clipper.CleanPolygon(biggest, 0.01 * config.curveTolerance * config.clipperScale);

			if (!clean || clean.length == 0) {
				return null;
			}

			var cleaned = this.clipperToSvg(clean);

			// remove duplicate endpoints
			var start = cleaned[0];
			var end = cleaned[cleaned.length - 1];
			if (start == end || (GeometryUtil.almostEqual(start.x, end.x) && GeometryUtil.almostEqual(start.y, end.y))) {
				cleaned.pop();
			}

			return cleaned;
		}


		// converts a polygon from normal float coordinates to integer coordinates used by clipper, as well as x/y -> X/Y
		this.svgToClipper = function (polygon, scale) {
			var clip = [];
			for (var i = 0; i < polygon.length; i++) {
				clip.push({ X: polygon[i].x, Y: polygon[i].y });
			}

			ClipperLib.JS.ScaleUpPath(clip, scale || config.clipperScale);

			return clip;
		}

		this.clipperToSvg = function (polygon) {
			var normal = [];

			for (var i = 0; i < polygon.length; i++) {
				normal.push({ x: polygon[i].X / config.clipperScale, y: polygon[i].Y / config.clipperScale });
			}

			return normal;
		}

		// returns an array of SVG elements that represent the placement, for export or rendering
		this.applyPlacement = function (placement) {
			var i, j, k;
			var clone = [];
			for (i = 0; i < parts.length; i++) {
				clone.push(parts[i].cloneNode(false));
			}

			var svglist = [];

			for (i = 0; i < placement.length; i++) {
				var newsvg = svg.cloneNode(false);
				newsvg.setAttribute('viewBox', '0 0 ' + binBounds.width + ' ' + binBounds.height);
				newsvg.setAttribute('width', binBounds.width + 'px');
				newsvg.setAttribute('height', binBounds.height + 'px');
				var binclone = bin.cloneNode(false);

				binclone.setAttribute('class', 'bin');
				binclone.setAttribute('transform', 'translate(' + (-binBounds.x) + ' ' + (-binBounds.y) + ')');
				newsvg.appendChild(binclone);

				for (j = 0; j < placement[i].length; j++) {
					var p = placement[i][j];
					var part = tree[p.id];

					// the original path could have transforms and stuff on it, so apply our transforms on a group
					var partgroup = document.createElementNS(svg.namespaceURI, 'g');
					partgroup.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ') rotate(' + p.rotation + ')');
					partgroup.appendChild(clone[part.source]);

					if (part.children && part.children.length > 0) {
						var flattened = _flattenTree(part.children, true);
						for (k = 0; k < flattened.length; k++) {

							var c = clone[flattened[k].source];
							if (flattened[k].hole) {
								c.setAttribute('class', 'hole');
							}
							partgroup.appendChild(c);
						}
					}

					newsvg.appendChild(partgroup);
				}

				svglist.push(newsvg);
			}

			// flatten the given tree into a list
			function _flattenTree(t, hole) {
				var flat = [];
				for (var i = 0; i < t.length; i++) {
					flat.push(t[i]);
					t[i].hole = hole;
					if (t[i].children && t[i].children.length > 0) {
						flat = flat.concat(_flattenTree(t[i].children, !hole));
					}
				}

				return flat;
			}

			return svglist;
		}

		this.stop = function () {
			this.working = false;
			if (GA && GA.population && GA.population.length > 0) {
				GA.population.forEach(function (i) {
					i.processing = false;
				});
			}
			if (workerTimer) {
				clearInterval(workerTimer);
				workerTimer = null;
			}
		};

		this.reset = function () {
			GA = null;
			while (this.nests.length > 0) {
				this.nests.pop();
			}
			progressCallback = null;
			displayCallback = null;
		}
	}

	function GeneticAlgorithm(adam, config) {

		this.config = config || { populationSize: 10, mutationRate: 10, rotations: 4 };

		// population is an array of individuals. Each individual is a object representing the order of insertion and the angle each part is rotated
		var angles = [];
		for (var i = 0; i < adam.length; i++) {
			var angle = Math.floor(Math.random() * this.config.rotations) * (360 / this.config.rotations);
			angles.push(angle);
		}

		this.population = [{ placement: adam, rotation: angles }];

		while (this.population.length < config.populationSize) {
			var mutant = this.mutate(this.population[0]);
			this.population.push(mutant);
		}
	}

	// returns a mutated individual with the given mutation rate
	GeneticAlgorithm.prototype.mutate = function (individual) {
		var clone = { placement: individual.placement.slice(0), rotation: individual.rotation.slice(0) };
		for (var i = 0; i < clone.placement.length; i++) {
			var rand = Math.random();
			if (rand < 0.01 * this.config.mutationRate) {
				// swap current part with next part
				var j = i + 1;

				if (j < clone.placement.length) {
					var temp = clone.placement[i];
					clone.placement[i] = clone.placement[j];
					clone.placement[j] = temp;
				}
			}

			rand = Math.random();
			if (rand < 0.01 * this.config.mutationRate) {
				clone.rotation[i] = Math.floor(Math.random() * this.config.rotations) * (360 / this.config.rotations);
			}
		}

		return clone;
	}

	// single point crossover
	GeneticAlgorithm.prototype.mate = function (male, female) {
		var cutpoint = Math.round(Math.min(Math.max(Math.random(), 0.1), 0.9) * (male.placement.length - 1));

		var gene1 = male.placement.slice(0, cutpoint);
		var rot1 = male.rotation.slice(0, cutpoint);

		var gene2 = female.placement.slice(0, cutpoint);
		var rot2 = female.rotation.slice(0, cutpoint);

		var i;

		for (i = 0; i < female.placement.length; i++) {
			if (!contains(gene1, female.placement[i].id)) {
				gene1.push(female.placement[i]);
				rot1.push(female.rotation[i]);
			}
		}

		for (i = 0; i < male.placement.length; i++) {
			if (!contains(gene2, male.placement[i].id)) {
				gene2.push(male.placement[i]);
				rot2.push(male.rotation[i]);
			}
		}

		function contains(gene, id) {
			for (var i = 0; i < gene.length; i++) {
				if (gene[i].id == id) {
					return true;
				}
			}
			return false;
		}

		return [{ placement: gene1, rotation: rot1 }, { placement: gene2, rotation: rot2 }];
	}

	GeneticAlgorithm.prototype.generation = function () {

		// Individuals with higher fitness are more likely to be selected for mating
		this.population.sort(function (a, b) {
			return a.fitness - b.fitness;
		});

		// fittest individual is preserved in the new generation (elitism)
		var newpopulation = [this.population[0]];

		while (newpopulation.length < this.population.length) {
			var male = this.randomWeightedIndividual();
			var female = this.randomWeightedIndividual(male);

			// each mating produces two children
			var children = this.mate(male, female);

			// slightly mutate children
			newpopulation.push(this.mutate(children[0]));

			if (newpopulation.length < this.population.length) {
				newpopulation.push(this.mutate(children[1]));
			}
		}

		this.population = newpopulation;
	}

	// returns a random individual from the population, weighted to the front of the list (lower fitness value is more likely to be selected)
	GeneticAlgorithm.prototype.randomWeightedIndividual = function (exclude) {
		var pop = this.population.slice(0);

		if (exclude && pop.indexOf(exclude) >= 0) {
			pop.splice(pop.indexOf(exclude), 1);
		}

		var rand = Math.random();

		var lower = 0;
		var weight = 1 / pop.length;
		var upper = weight;

		for (var i = 0; i < pop.length; i++) {
			// if the random number falls between lower and upper bounds, select this individual
			if (rand > lower && rand < upper) {
				return pop[i];
			}
			lower = upper;
			upper += 2 * weight * ((pop.length - i) / pop.length);
		}

		return pop[0];
	}

})(this);