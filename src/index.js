// 第一步首先实现 createElement 函数，把 JSX 转换成 JS
// 参考 https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Operators/Spread_syntax
// 注意：这里 children 始终是数组
function createElement(type, props, ...children)
{
	return {
		type,
		props : {
			...props,
			children : children.map(child =>
				typeof child === "object" ? child : createTextElement(child)
			)
		}
	};
}

function createTextElement(text)
{
	return {
		// children 可能包含字符串或者数字这类基础类型值，给这里值包裹成 TEXT_ELEMENT 特殊类型，方便后面统一处理。
		type  : "TEXT_ELEMENT",
		props : {
			nodeValue : text,
			children  : []
		}
	};
}

function createDom(fiber)
{
	const dom =
		fiber.type === "TEXT_ELEMENT"
			? document.createTextNode("")
			: document.createElement(fiber.type);

	updateDom(dom, {}, fiber.props);

	return dom;
}

const isEvent = key => key.startsWith("on");
const isProperty = key => key !== "children" && !isEvent(key);
const isNew = (prev, next) => key => prev[key] !== next[key];
const isGone = (prev, next) => key => !(key in next);

// 新增函数，更新 DOM 节点
function updateDom(dom, prevProps, nextProps)
{
	// 以 “on” 开头的属性作为事件要特别处理
	// 移除旧的或者变化了的的事件处理函数
	Object.keys(prevProps)
		.filter(isEvent)
		.filter(key => !(key in nextProps) || isNew(prevProps, nextProps)(key))
		.forEach(name => {
			const eventType = name.toLowerCase().substring(2);
			dom.removeEventListener(eventType, prevProps[name]);
		});

	// 移除旧的属性
	Object.keys(prevProps)
		.filter(isProperty)
		.filter(isGone(prevProps, nextProps))
		.forEach(name => {
			dom[name] = "";
		});

	// 添加或者更新属性
	Object.keys(nextProps)
		.filter(isProperty)
		.filter(isNew(prevProps, nextProps))
		.forEach(name => {
			// React 规定 style 内联样式是驼峰命名的对象，
			// 根据规范给 style 每个属性单独赋值
			if (name === "style") {
				Object.entries(nextProps[name]).forEach(([key, value]) => {
					dom.style[key] = value;
				});
			} else {
				dom[name] = nextProps[name];
			}
		});

	// 添加新的事件处理函数
	Object.keys(nextProps)
		.filter(isEvent)
		.filter(isNew(prevProps, nextProps))
		.forEach(name => {
			const eventType = name.toLowerCase().substring(2);
			dom.addEventListener(eventType, nextProps[name]);
		});
}

function commitRoot()
{
	deletions.forEach(commitWork);
	commitWork(wipRoot.child);
	currentRoot = wipRoot;
	wipRoot = null;
}

function commitWork(fiber)
{
	if (!fiber) {
		return;
	}

	// 当 fiber 是函数组件时节点不存在 DOM，
	// 故需要遍历父节点以找到最近的有 DOM 的节点
	let domParentFiber = fiber.parent;
	while (!domParentFiber.dom) {
		domParentFiber = domParentFiber.parent;
	}
	const domParent = domParentFiber.dom;
	if (fiber.effectTag === "PLACEMENT" && fiber.dom != null) {
		domParent.appendChild(fiber.dom);
	} else if (fiber.effectTag === "UPDATE" && fiber.dom != null) {
		updateDom(fiber.dom, fiber.alternate.props, fiber.props);
	} else if (fiber.effectTag === "DELETION") {
		// 直接移除 DOM 替换成 commitDeletion 函数
		commitDeletion(fiber, domParent);
	}

	commitWork(fiber.child);
	commitWork(fiber.sibling);
}

// 新增函数，移除 DOM 节点
function commitDeletion(fiber, domParent)
{
	// 当 child 是函数组件时不存在 DOM，
	// 故需要递归遍历子节点找到真正的 DOM
	if (fiber.dom) {
		domParent.removeChild(fiber.dom);
	} else {
		commitDeletion(fiber.child, domParent);
	}
}

function render(element, container)
{
	wipRoot = {
		dom       : container,
		props     : {
			children : [element]
		},
		alternate : currentRoot
	};
	deletions = [];
	nextUnitOfWork = wipRoot;
}

let nextUnitOfWork = null;
let currentRoot = null;
let wipRoot = null;
let deletions = null;

// 并发模式 / Concurrent Mode
function workLoop(deadline)
{
	let shouldYield = false;
	while (nextUnitOfWork && !shouldYield) {
		nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
		// 回调函数入参 deadline 可以告诉我们在这个渲染周期还剩多少时间可用
		// 剩余时间小于1毫秒就退出回调，等待浏览器再次空闲
		shouldYield = deadline.timeRemaining() < 1
	}
	window.requestIdleCallback(workLoop);
}

window.requestIdleCallback(workLoop);

// 注意，这个函数执行完本次单元任务之后要返回下一个单元任务
function performUnitOfWork(fiber)
{
	const isFunctionComponent = fiber.type instanceof Function;
	// 原本逻辑挪到 updateHostComponent 函数
	if (isFunctionComponent) {
		updateFunctionComponent(fiber);
	} else {
		updateHostComponent(fiber);
	}
	if (fiber.child) {
		return fiber.child;
	}
	let nextFiber = fiber;
	while (nextFiber) {
		if (nextFiber.sibling) {
			return nextFiber.sibling;
		}
		nextFiber = nextFiber.parent;
	}
}

// 新增变量，渲染进行中的 fiber 节点
let wipFiber = null;
// 新增变量，当前 hook 的索引
let hookIndex = null;

// 处理函数组件
function updateFunctionComponent(fiber)
{
	// 更新进行中的 fiber 节点
	wipFiber = fiber;
	// 重置 hook 索引
	hookIndex = 0;
	// 新增 hooks 数组以支持同一个组件多次调用 `useState`
	wipFiber.hooks = [];
	const children = [fiber.type(fiber.props)];
	reconcileChildren(fiber, children);
}

function useState(initial)
{
	// alternate 保存了上一次渲染的 fiber 节点
	const oldHook =
		wipFiber.alternate &&
		wipFiber.alternate.hooks &&
		wipFiber.alternate.hooks[hookIndex];
	const hook = {
		// 第一次渲染使用入参，第二次渲染复用前一次的状态
		state : oldHook ? oldHook.state : initial,
		// 保存每次 setState 入参的队列
		queue : []
	};

	const actions = oldHook ? oldHook.queue : [];
	actions.forEach(action => {
		// 根据调用 setState 顺序从前往后生成最新的 state
		hook.state = typeof action === "function" ? action(hook.state) : action;
	});

	// setState 函数用于更新 state，入参 action
	// 是新的 state 值或函数返回新的 state
	const setState = action => {
		hook.queue.push(action);
		// 下面这部分代码和 render 函数很像，
		// 设置新的 wipRoot 和 nextUnitOfWork
		// 浏览器空闲时即开始重新渲染。
		wipRoot = {
			dom       : currentRoot.dom,
			props     : currentRoot.props,
			alternate : currentRoot
		};
		nextUnitOfWork = wipRoot;
		deletions = [];
	};

	// 保存本次 hook
	wipFiber.hooks.push(hook);
	hookIndex++;
	return [hook.state, setState];
}

// 新增函数，处理原生标签组件
function updateHostComponent(fiber)
{
	if (!fiber.dom) {
		fiber.dom = createDom(fiber);
	}
	reconcileChildren(fiber, fiber.props.children);
}

// 新增函数
function reconcileChildren(wipFiber, elements)
{
	let index = 0;
	// 上次渲染完成之后的 fiber 节点
	let oldFiber = wipFiber.alternate && wipFiber.alternate.child;
	let prevSibling = null;

	// 扁平化 props.children，处理函数组件的 children
	elements = elements.flat();

	while (index < elements.length || oldFiber != null) {
		// 本次需要渲染的子元素
		const element = elements[index];
		let newFiber = null;

		// 比较当前和上一次渲染的 type，即 DOM tag 'div'，
		// 暂不考虑自定义组件
		const sameType = oldFiber && element && element.type === oldFiber.type;

		// 同类型节点，只需更新节点 props 即可
		if (sameType) {
			newFiber = {
				type      : oldFiber.type,
				props     : element.props,
				dom       : oldFiber.dom, // 复用旧节点的 DOM
				parent    : wipFiber,
				alternate : oldFiber,
				effectTag : "UPDATE" // 新增属性，在提交/commit 阶段使用
			};
		}
		// 不同类型节点且存在新的元素时，创建新的 DOM 节点
		if (element && !sameType) {
			newFiber = {
				type      : element.type,
				props     : element.props,
				dom       : null,
				parent    : wipFiber,
				alternate : null,
				effectTag : "PLACEMENT" // PLACEMENT 表示需要添加新的节点
			};
		}
		// 不同类型节点，且存在旧的 fiber 节点时，
		// 需要移除该节点
		if (oldFiber && !sameType) {
			oldFiber.effectTag = "DELETION";
			// 当最后提交 fiber 树到 DOM 时，我是从 wipRoot 开始的，
			// 此时没有上一次的 fiber，所以这里用一个数组来跟踪需要
			// 删除的节点
			deletions.push(oldFiber);
		}

		if (oldFiber) {
			oldFiber = oldFiber.sibling;
		}

		if (index === 0) {
			wipFiber.child = newFiber;
		} else {
			prevSibling.sibling = newFiber;
		}

		prevSibling = newFiber;
		index++;
	}
}

// 框架叫做 redact，以区别 react
const Redact = {
	createElement,
	render,
	useState
};

/** @jsx Redact.createElement */
function Counter(props)
{
	const [state, setState] = Redact.useState(1);
	return (
		<div
			style={{ display : "flex", flexDirection : "column", alignItems : "center" }}
		>
			<h1 onClick={() => setState(c => c + 1)}>Count: {state}</h1>
			{props.children}
		</div>
	);
}

const element = (
	<Counter>
		<p>Child node</p>
	</Counter>
);
const container = document.getElementById("root");
Redact.render(element, container);