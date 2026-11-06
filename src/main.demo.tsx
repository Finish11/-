/**
 * Точка входа демо-сборки: тот же самый UI, но без backend —
 * fetch к /api/* обслуживается локальным mock-сервером из JSON-сида.
 */
import './demo/localApi';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { hydrateCommunityStorage } from './lib/community';

async function boot() {
  await hydrateCommunityStorage();
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
}
void boot();
