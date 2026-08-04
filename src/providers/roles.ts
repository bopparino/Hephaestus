import type { Config } from '../daemon/config.js';
import { getSecret } from '../daemon/paths.js';
import type { ModelRole, ProviderAdapter } from './types.js';
import { ProviderError } from './types.js';
import { OllamaAdapter } from './ollama.js';
import { AnthropicAdapter } from './anthropic.js';

export interface RoleBinding {
  adapter: ProviderAdapter;
  model: string;
}

export class Providers {
  private ollama: OllamaAdapter;
  private anthropic: AnthropicAdapter;

  constructor(private cfg: Config) {
    this.ollama = new OllamaAdapter(cfg.providers.ollama.url);
    this.anthropic = new AnthropicAdapter(() => getSecret('ANTHROPIC_API_KEY'));
  }

  /** "provider/model" → adapter + model. The one seam every model call crosses. */
  resolve(role: ModelRole): RoleBinding {
    const spec = this.cfg.models[role];
    const slash = spec.indexOf('/');
    const provider = slash === -1 ? spec : spec.slice(0, slash);
    let model = slash === -1 ? '' : spec.slice(slash + 1);
    switch (provider) {
      case 'ollama':
        return { adapter: this.ollama, model: model || 'auto' };
      case 'anthropic':
        return { adapter: this.anthropic, model: model || this.cfg.providers.anthropic.modelDefault };
      default:
        throw new ProviderError(`unknown provider "${provider}" for role ${role}`, 'bad_request');
    }
  }

  bindings(): Record<ModelRole, string> {
    return { ...this.cfg.models };
  }

  /** Installed-model catalog for the shell's switcher. */
  async listInstalled(): Promise<{ provider: string; model: string; spec: string }[]> {
    const out: { provider: string; model: string; spec: string }[] = [];
    try {
      for (const name of (await this.ollama.listModels()).filter(n => !/embed/i.test(n))) {
        out.push({ provider: 'ollama', model: name, spec: `ollama/${name}` });
      }
    } catch { /* ollama down — list what we can */ }
    out.push({
      provider: 'anthropic',
      model: this.cfg.providers.anthropic.modelDefault,
      spec: `anthropic/${this.cfg.providers.anthropic.modelDefault}`,
    });
    return out;
  }
}
