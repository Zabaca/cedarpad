import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Shell } from './Shell';
import '../../shared/chat.css'; // the shared <ChatView> chrome (Inbox thread renders it)
import './shell.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
