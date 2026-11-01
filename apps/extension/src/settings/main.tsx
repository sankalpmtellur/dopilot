import { applyTheme, Brand } from '@dopilot/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsForm } from './settings-form';
import '@/styles/app.css';

applyTheme();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <main className="mx-auto flex max-w-lg flex-col gap-6 px-5 py-8">
      <header>
        <Brand />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Settings</h1>
      </header>
      <SettingsForm />
    </main>
  </StrictMode>,
);
