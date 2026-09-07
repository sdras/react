// A stand-in for `document.modelContext` that is installed only when the
// browser has no WebMCP support. It records registrations, honors the
// AbortSignal contract for unregistration, and can run tools, so the fixture
// works in any browser and gives the CI contract check something to assert
// against. When the native API exists it is left untouched.

if (typeof document !== 'undefined' && document.modelContext == null) {
  const tools = new Map();
  const listeners = new Set();

  function emitToolChange() {
    listeners.forEach(listener => {
      try {
        listener({type: 'toolchange'});
      } catch (error) {
        // Listeners must not break registration.
      }
    });
  }

  const shim = {
    __isShim: true,
    registerTool(tool, options) {
      if (tool == null || typeof tool.name !== 'string' || tool.name === '') {
        throw new TypeError('registerTool: the tool needs a name.');
      }
      if (typeof tool.execute !== 'function') {
        throw new TypeError(
          'registerTool: the tool "' +
            tool.name +
            '" needs an execute function.'
        );
      }
      if (tools.has(tool.name)) {
        throw new DOMException(
          'A tool named "' + tool.name + '" is already registered.',
          'InvalidStateError'
        );
      }
      const signal = options != null ? options.signal : null;
      if (signal != null && signal.aborted) {
        return undefined;
      }
      const entry = {tool};
      tools.set(tool.name, entry);
      if (signal != null) {
        signal.addEventListener(
          'abort',
          () => {
            if (tools.get(tool.name) === entry) {
              tools.delete(tool.name);
              emitToolChange();
            }
          },
          {once: true}
        );
      }
      emitToolChange();
      return undefined;
    },
    getTools() {
      return Promise.resolve(
        Array.from(tools.values()).map(({tool}) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        }))
      );
    },
    executeTool(nameOrTool, input) {
      const name =
        typeof nameOrTool === 'string' ? nameOrTool : nameOrTool.name;
      const entry = tools.get(name);
      if (entry === undefined) {
        return Promise.reject(new Error('No tool named "' + name + '".'));
      }
      const args =
        typeof input === 'string'
          ? JSON.parse(input)
          : input == null
            ? {}
            : input;
      return Promise.resolve(entry.tool.execute(args, {signal: null}));
    },
    addEventListener(type, listener) {
      if (type === 'toolchange') {
        listeners.add(listener);
      }
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
    },
  };

  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    enumerable: false,
    value: shim,
  });

  // Read by the contract check and handy in the console.
  window.__WEBMCP_SHIM__ = {
    names: () => Array.from(tools.keys()).sort(),
    tools,
    execute: (name, input) => shim.executeTool(name, input),
  };
}
