import * as React from 'react';
import {
  useWebMCPTool,
  ToolScope,
  ToolTree,
  Tool,
  Scope,
  unstable_getRegisteredTools,
  unstable_subscribeToRegisteredTools,
} from 'react-webmcp';

const {useState, useSyncExternalStore, Suspense} = React;

// ---------------------------------------------------------------------------
// Todos: the hook path. Tools live next to the state and handlers they use.
// ---------------------------------------------------------------------------

function TodoTools({todos, addTodo, clearTodos}) {
  useWebMCPTool({
    name: 'add_todo',
    description: 'Add a new item to the todo list.',
    safety: 'mutate',
    inputSchema: {
      type: 'object',
      properties: {
        text: {type: 'string', description: 'The text of the todo item.'},
      },
      required: ['text'],
    },
    execute: ({text}) => {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('Provide the text of the todo item.');
      }
      addTodo(text.trim());
      return (
        'Added "' +
        text.trim() +
        '". The list now has ' +
        (todos.length + 1) +
        ' items.'
      );
    },
  });

  useWebMCPTool({
    name: 'list_todos',
    description: 'List the current todo items in order.',
    safety: 'read',
    execute: () =>
      todos.length === 0
        ? 'The todo list is empty.'
        : todos.map((todo, index) => index + 1 + '. ' + todo).join('\n'),
  });

  useWebMCPTool({
    name: 'clear_todos',
    description: 'Delete every item from the todo list. This cannot be undone.',
    safety: 'irreversible',
    execute: () => {
      const count = todos.length;
      clearTodos();
      return 'Removed ' + count + ' items.';
    },
  });

  return null;
}

// Registers the same agent-facing name as TodoTools to demonstrate the DEV
// collision warning and the resulting error status.
function DuplicateTodoTool() {
  useWebMCPTool({
    key: 'duplicate-demo',
    name: 'add_todo',
    description: 'A second tool with the same name, on purpose.',
    safety: 'mutate',
    execute: () => 'This should never win.',
  });
  return null;
}

function SearchTools({todos}) {
  useWebMCPTool({
    name: 'search_todos',
    description: 'Find todo items whose text contains a phrase.',
    safety: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'Text to look for.'},
      },
      required: ['query'],
    },
    execute: ({query}) => {
      const matches = todos.filter(todo =>
        todo.toLowerCase().includes(String(query).toLowerCase())
      );
      return matches.length === 0
        ? 'No todo items match "' + query + '".'
        : matches.join('\n');
    },
  });
  return null;
}

function Todos({todos, setTodos}) {
  const [draft, setDraft] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [showDuplicate, setShowDuplicate] = useState(false);

  const addTodo = text => setTodos(current => current.concat(text));
  const clearTodos = () => setTodos([]);

  return (
    <section className="panel" data-testid="todos">
      <h2>Todos (hook path)</h2>
      <p className="muted">
        <code>useWebMCPTool</code> inside{' '}
        <code>&lt;ToolScope name="todos"&gt;</code>.
      </p>
      <ToolScope name="todos">
        <TodoTools todos={todos} addTodo={addTodo} clearTodos={clearTodos} />
        {showDuplicate ? <DuplicateTodoTool /> : null}
        <ToolScope name="search" available={!searchLoading}>
          <SearchTools todos={todos} />
        </ToolScope>
      </ToolScope>
      <form
        className="row"
        onSubmit={event => {
          event.preventDefault();
          if (draft.trim() !== '') {
            addTodo(draft.trim());
            setDraft('');
          }
        }}>
        <input
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="Something to do"
          aria-label="New todo"
        />
        <button type="submit">Add</button>
        <button type="button" onClick={clearTodos}>
          Clear
        </button>
      </form>
      <ul>
        {todos.map((todo, index) => (
          <li key={index}>{todo}</li>
        ))}
      </ul>
      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={searchLoading}
            onChange={event => setSearchLoading(event.target.checked)}
          />{' '}
          Simulate search index loading (makes <code>todos_search_*</code>{' '}
          unavailable)
        </label>
      </div>
      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={showDuplicate}
            onChange={event => setShowDuplicate(event.target.checked)}
            data-testid="toggle-duplicate"
          />{' '}
          Mount a duplicate <code>add_todo</code> (DEV warning demo)
        </label>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cart: the tree path. Tools disappear while the inventory suspends.
// ---------------------------------------------------------------------------

const INVENTORY = [
  {sku: 'TEA-001', name: 'Green tea', price: 8},
  {sku: 'TEA-002', name: 'Earl Grey', price: 9},
  {sku: 'CUP-001', name: 'Ceramic cup', price: 14},
];

// A tiny suspense-compatible resource with a delay, so the cart tools visibly
// come and go.
function createInventoryResource(delayMs) {
  let status = 'pending';
  let result;
  const promise = new Promise(resolve => {
    setTimeout(() => {
      status = 'done';
      result = INVENTORY;
      resolve(INVENTORY);
    }, delayMs);
  });
  return {
    read() {
      if (status === 'pending') {
        throw promise;
      }
      return result;
    },
  };
}

// Suspends for as long as `suspended` is true; used by the contract check to
// verify that cart tools are unregistered while their UI is hidden.
function Gate({suspended}) {
  const gateRef = React.useRef(null);
  if (suspended) {
    if (gateRef.current === null) {
      let release;
      const promise = new Promise(resolve => {
        release = resolve;
      });
      gateRef.current = {promise, release};
    }
    throw gateRef.current.promise;
  }
  if (gateRef.current !== null) {
    gateRef.current.release();
    gateRef.current = null;
  }
  return null;
}

function Inventory({resource, cart, addItem, clearCart}) {
  const items = resource.read();
  return (
    <div>
      <ul>
        {items.map(item => (
          <li key={item.sku} className="row">
            <span>
              {item.name}{' '}
              <span className="muted">
                ({item.sku}, ${item.price})
              </span>
            </span>
            <button type="button" onClick={() => addItem(item.sku, 1)}>
              Add
            </button>
          </li>
        ))}
      </ul>
      <ToolTree>
        <Scope name="cart">
          <Tool
            name="add_item"
            description="Add an inventory item to the cart by SKU."
            safety="mutate"
            inputSchema={{
              type: 'object',
              properties: {
                sku: {
                  type: 'string',
                  description: 'SKU of the item to add, e.g. TEA-001.',
                },
                quantity: {
                  type: 'number',
                  description: 'How many to add (default 1).',
                },
              },
              required: ['sku'],
            }}
            execute={({sku, quantity}) => {
              const item = items.find(candidate => candidate.sku === sku);
              if (item === undefined) {
                throw new Error(
                  'Unknown SKU "' +
                    sku +
                    '". Available: ' +
                    items.map(candidate => candidate.sku).join(', ')
                );
              }
              const count = quantity == null ? 1 : Number(quantity);
              addItem(item.sku, count);
              return 'Added ' + count + ' x ' + item.name + ' to the cart.';
            }}
          />
          <Tool
            name="list_items"
            description="List the items in the cart with quantities and the total price."
            safety="read"
            execute={() => {
              const lines = Object.keys(cart).map(sku => {
                const item = items.find(candidate => candidate.sku === sku);
                return cart[sku] + ' x ' + (item ? item.name : sku);
              });
              return lines.length === 0
                ? 'The cart is empty.'
                : lines.join('\n') + '\nTotal: $' + cartTotal(cart, items);
            }}
          />
          <Tool
            name="clear"
            description="Remove every item from the cart. This cannot be undone."
            safety="irreversible"
            execute={() => {
              clearCart();
              return 'The cart is now empty.';
            }}
          />
        </Scope>
      </ToolTree>
    </div>
  );
}

function cartTotal(cart, items) {
  return Object.keys(cart).reduce((sum, sku) => {
    const item = items.find(candidate => candidate.sku === sku);
    return sum + (item ? item.price * cart[sku] : 0);
  }, 0);
}

function Cart() {
  const [resource, setResource] = useState(() => createInventoryResource(1500));
  const [suspended, setSuspended] = useState(false);
  const [cart, setCart] = useState({});

  const addItem = (sku, quantity) =>
    setCart(current => ({...current, [sku]: (current[sku] || 0) + quantity}));
  const clearCart = () => setCart({});

  return (
    <section className="panel" data-testid="cart">
      <h2>Cart (tree path)</h2>
      <p className="muted">
        <code>&lt;ToolTree&gt;</code> inside a <code>&lt;Suspense&gt;</code>{' '}
        boundary. While the inventory loads, the <code>cart_*</code> tools are
        unregistered.
      </p>
      <div className="row">
        <button
          type="button"
          onClick={() => setResource(createInventoryResource(1500))}>
          Reload inventory
        </button>
        <button
          type="button"
          data-testid="toggle-suspend-cart"
          onClick={() => setSuspended(value => !value)}>
          {suspended ? 'Resume cart' : 'Suspend cart'}
        </button>
        <span className="muted">
          {Object.keys(cart).length === 0
            ? 'Cart is empty'
            : Object.keys(cart)
                .map(sku => cart[sku] + ' x ' + sku)
                .join(', ')}
        </span>
      </div>
      <Suspense fallback={<p className="muted">Loading inventory…</p>}>
        <Inventory
          resource={resource}
          cart={cart}
          addItem={addItem}
          clearCart={clearCart}
        />
        <Gate suspended={suspended} />
      </Suspense>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tools panel: the registry as the app sees it (v0 of the review UI).
// ---------------------------------------------------------------------------

function ToolsPanel() {
  const tools = useSyncExternalStore(
    unstable_subscribeToRegisteredTools,
    unstable_getRegisteredTools,
    unstable_getRegisteredTools
  );
  const shim =
    typeof document !== 'undefined' &&
    document.modelContext != null &&
    document.modelContext.__isShim === true;
  return (
    <section className="panel" data-testid="tools-panel">
      <h2>Registered tools</h2>
      <p className="muted">
        {shim
          ? 'This browser has no WebMCP; a shim records registrations. Enable chrome://flags/#enable-webmcp-testing to use the real API.'
          : 'Registered with the native document.modelContext.'}
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Source</th>
            <th>Safety</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {tools.map(tool => (
            <tr key={tool.key} data-tool-name={tool.qualifiedName}>
              <td>
                <code>{tool.qualifiedName}</code>
                {tool.error != null ? (
                  <div className="muted">{tool.error}</div>
                ) : null}
              </td>
              <td>{tool.source}</td>
              <td>{tool.safety == null ? '—' : tool.safety}</td>
              <td className={'status-' + tool.status}>{tool.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function App() {
  const [todos, setTodos] = useState(['Try the WebMCP pane', 'Add an item']);
  return (
    <main className="app">
      <h1>react-webmcp fixture</h1>
      <p className="muted">
        Tools derived from this React tree. Open Chrome DevTools → Application →
        WebMCP (with the WebMCP flags enabled) to see them as an agent would.
      </p>
      <div className="grid">
        <Todos todos={todos} setTodos={setTodos} />
        <Cart />
      </div>
      <ToolsPanel />
    </main>
  );
}
