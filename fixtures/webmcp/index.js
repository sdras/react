// The chrome-devtools-mcp registration must run before React so the DevTools
// hook is installed when the renderers inject on their first commit.
import '../../packages/react-devtools-cdt-mcp/src/register.js';
// Then the modelContext shim, so react-webmcp finds a registration target in
// browsers without WebMCP (and in headless CI).
import './src/modelContextShim';

import * as React from 'react';
import {createRoot} from 'react-dom/client';

import App from './src/App';

const root = createRoot(document.getElementById('root'));
root.render(<App />);
