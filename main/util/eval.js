
//import这段代码 能为worker或者process安装 onMessage事件，并用于执行任意发来的代码


var isNode = typeof module !== 'undefined' && module.exports;

if (isNode) {
	process.once('message', function (code) {
		eval(JSON.parse(code).data);
	});
} else {
	self.onmessage = function (code) {
		eval(code.data);
	};
}