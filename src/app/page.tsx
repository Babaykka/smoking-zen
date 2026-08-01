import { WorkspaceBootstrap, type BrowserProductionConfig } from '@/components/workspace-bootstrap';

export default function Home() {
  const mode = process.env.APP_MODE === 'demo' ? 'demo' : 'production';
  const productionConfig: BrowserProductionConfig | undefined = mode === 'production' && process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY
    ? { supabaseUrl: process.env.SUPABASE_URL, supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY }
    : undefined;
  return <WorkspaceBootstrap mode={mode} productionConfig={productionConfig} />;
}
