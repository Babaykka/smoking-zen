import { WorkspaceBootstrap, type BrowserProductionConfig } from '@/components/workspace-bootstrap';
import { parseBrowserProductionEnvironment } from '@/server/env';

export default function Home() {
  const mode = process.env.APP_MODE === 'demo' ? 'demo' : 'production';
  const productionConfig: BrowserProductionConfig | undefined = parseBrowserProductionEnvironment(process.env);
  return <WorkspaceBootstrap mode={mode} productionConfig={productionConfig} />;
}
