import { Bot } from 'lucide-react';
import { ExtensionStatus } from '@/components/extension-status';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
      <Bot aria-hidden className="size-8" />
      <h1 className="text-3xl font-semibold tracking-tight">Dopilot</h1>
      <p className="text-zinc-600">Open-source, voice-controlled AI agent for Chrome and Brave.</p>
      <ExtensionStatus />
    </main>
  );
}
