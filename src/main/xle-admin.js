'use strict';

// Runs entirely in the Haven page world. No Electron bridge, filesystem,
// provider credentials, or arbitrary URL/method API is exposed by this module.
function createXleClient({ fetch, getSession, signal }) {
  const session = getSession();
  const current = () => {
    const next = getSession();
    return !!session?.token && session.admin === true && next?.admin === true &&
      session.token === next.token && session.identity === next.identity && !signal?.aborted;
  };
  function fail(key) { const error = new Error(key); error.key = key; throw error; }
  const validId = id => typeof id === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(id);
  const positiveId = id => Number.isSafeInteger(id) && id > 0;
  const provider = value => value === 'openai' || value === 'xai';
  function character(c) {
    if (!c || !validId(c.id) || typeof c.name !== 'string' || !c.name || c.name.length > 64 ||
        typeof c.role !== 'string' || c.role.length > 64 || !provider(c.provider) ||
        typeof c.enabled !== 'boolean' || typeof c.provisioned !== 'boolean' ||
        !(c.channel_id === null || positiveId(c.channel_id))) fail('xle.error.invalidResponse');
    // Deliberately discard everything else, including any future credential fields.
    return { id: c.id, name: c.name, role: c.role, provider: c.provider,
      enabled: c.enabled, provisioned: c.provisioned, channel_id: c.channel_id };
  }
  const knownErrors = {
    'XLE disabled in configuration': 'xle.error.disabled',
    'XLE disabled': 'xle.error.disabled',
    'Character lore has not been provided': 'xle.error.lore',
    'Character already provisioned': 'xle.error.provisioned',
    'Non-DM channel required': 'xle.error.channel',
    'Invalid channel': 'xle.error.channel',
    'Valid channel_id required': 'xle.error.channel',
    'Unknown or disabled character': 'xle.error.character',
    'Unknown character': 'xle.error.character',
    'XLE provider credentials or model not configured': 'xle.error.provider',
    'Direct AI egress disabled; deploy an isolated AI gateway before enabling model calls': 'xle.error.egress',
  };
  async function request(path, body) {
    if (!current()) fail('xle.error.session');
    const timeout = AbortSignal.timeout(25000);
    let response;
    try {
      response = await fetch(`/api/xle/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A redirect must never forward an admin token to another destination.
        redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (!current()) fail('xle.error.session');
      fail('xle.error.network');
    }
    if (!current()) fail('xle.error.session');
    if (response.status === 401) fail('xle.error.session');
    if (response.status === 403) fail('xle.error.forbidden');
    if (response.status === 429) fail('xle.error.rateLimit');
    if (response.status === 404 && body === undefined) fail('xle.error.unavailable');
    if (!response.headers.get('content-type')?.includes('application/json')) fail('xle.error.unavailable');
    let data;
    try { data = await response.json(); } catch { fail('xle.error.invalidResponse'); }
    if (!current()) fail('xle.error.session');
    if (!response.ok) fail(knownErrors[data?.error] || 'xle.error.request');
    return data;
  }
  return {
    current,
    async status() {
      const data = await request('status');
      if (!data || data.phase !== 1 || typeof data.enabled !== 'boolean' ||
          !Number.isInteger(data.characters) || data.characters < 0 || data.characters > 32) fail('xle.error.invalidResponse');
      const providers = {};
      for (const name of ['openai', 'xai']) {
        const p = data.providers?.[name];
        if (!p || typeof p.configured !== 'boolean' || typeof p.direct_egress_enabled !== 'boolean') fail('xle.error.invalidResponse');
        providers[name] = { configured: p.configured, direct_egress_enabled: p.direct_egress_enabled };
      }
      return { enabled: data.enabled, providers, characters: data.characters };
    },
    async characters() {
      const data = await request('characters');
      if (typeof data?.enabled !== 'boolean' || !Array.isArray(data.characters) || data.characters.length > 32) fail('xle.error.invalidResponse');
      const characters = data.characters.map(character);
      if (new Set(characters.map(c => c.id)).size !== characters.length) fail('xle.error.invalidResponse');
      return { enabled: data.enabled, characters };
    },
    async provision(id, channelId) {
      if (!validId(id)) fail('xle.error.character');
      if (!positiveId(channelId)) fail('xle.error.channel');
      const c = character((await request(`characters/${id}/provision`, { channel_id: channelId }))?.character);
      if (c.id !== id || !c.provisioned || c.channel_id !== channelId) fail('xle.error.invalidResponse');
      return c;
    },
    async preview(id, prompt) {
      if (!validId(id)) fail('xle.error.character');
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) fail('xle.error.prompt');
      const data = await request(`characters/${id}/preview`, { prompt: prompt.trim() });
      if (data?.character_id !== id || !provider(data.provider) ||
          typeof data.response !== 'string' || !data.response.trim() || data.response.length > 4000) fail('xle.error.invalidResponse');
      return data.response;
    },
  };
}

function installXleAdmin({ window, document, t }) {
  let panel = null;
  const getSession = () => ({ token: window.app?.token, admin: window.app?.user?.isAdmin === true,
    identity: window.app });
  function open() {
    if (panel) { panel.dialog.focus(); return; }
    if (!document.body) return;
    const controller = new AbortController();
    const client = createXleClient({ fetch: window.fetch.bind(window), getSession, signal: controller.signal });
    const host = document.createElement('div');
    host.id = 'haven-xle-admin';
    // Isolate styles and DOM from the server app's layouts. The server remains
    // the authorization boundary; a page script can already use its own token.
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { color-scheme: dark; }
      * { box-sizing: border-box; }
      dialog { width: min(940px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 0;
        background: #101a20; color: #edf3f2; border: 1px solid #38534d; border-radius: 16px;
        font: 14px/1.5 system-ui, sans-serif; box-shadow: 0 24px 90px #000a; }
      dialog::backdrop { background: #020909b8; }
      header, main { padding: 24px; } header { border-bottom: 1px solid #2d4242; }
      h1 { font-size: 25px; margin: 0; } h2 { font-size: 18px; margin: 0 0 12px; }
      h3 { font-size: 16px; margin: 0 0 6px; } p { margin: 8px 0 14px; }
      .top, .actions, .summary { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      .top { justify-content: space-between; } .eyebrow { color: #a9d99a; letter-spacing: .12em; font-size: 11px; }
      .muted { color: #b4c5c7; } .notice { border-left: 3px solid #b0d789; padding: 10px 14px; background: #1d2b28; }
      .summary { margin-bottom: 20px; } .summary > div { flex: 1 1 180px; padding: 16px; background: #19292d; border-radius: 9px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 14px; }
      article { padding: 18px; border: 1px solid #33494b; border-radius: 10px; background: #152329; }
      button, input, textarea { font: inherit; border: 1px solid #68827d; border-radius: 6px; padding: 8px 12px; }
      button { cursor: pointer; background: #b0d789; color: #102016; font-weight: 650; }
      button.secondary { color: #e1ece8; background: #243638; } button:disabled { opacity: .5; cursor: default; }
      button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid #8bd8ed; outline-offset: 3px; }
      input, textarea { background: #0b161b; color: #fff; width: 100%; margin: 6px 0 14px; }
      textarea { min-height: 100px; resize: vertical; } label { display: block; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0b161b; padding: 16px; border-radius: 8px; font: inherit; }
      .feedback { margin: 0 0 16px; color: #f6d9a6; } .feedback:empty { display: none; }
      footer { margin-top: 24px; padding-top: 18px; border-top: 1px solid #33494b; }
      @media (max-width: 550px) { header, main { padding: 16px; } h1 { font-size: 21px; } }
    `;
    root.append(style);
    const element = (tag, text, className) => {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = String(text);
      if (className) el.className = className;
      return el;
    };
    const dialog = element('dialog');
    dialog.setAttribute('aria-labelledby', 'xle-title');
    const header = element('header');
    const top = element('div', undefined, 'top');
    const titleBlock = element('div');
    titleBlock.append(element('div', 'XORISHI LORE ENGINE', 'eyebrow'));
    const title = element('h1', t('xle.title')); title.id = 'xle-title'; titleBlock.append(title);
    function button(text, action, secondary = false) {
      const el = element('button', text, secondary ? 'secondary' : '');
      el.type = 'button'; el.addEventListener('click', action); return el;
    }
    const close = () => {
      controller.abort();
      window.clearInterval(watch);
      panel = null;
      dialog.close(); host.remove();
    };
    const closeButton = button(t('xle.close'), close, true);
    top.append(titleBlock, closeButton); header.append(top, element('p', t('xle.subtitle'), 'muted'));
    const main = element('main');
    const feedback = element('p', '', 'feedback'); feedback.setAttribute('role', 'status');
    const content = element('div'); main.append(feedback, content);
    dialog.append(header, main); root.append(dialog); document.body.append(host);
    panel = { dialog };
    let busy = false;
    let status = null;
    let characters = [];
    function displayError(error) {
      feedback.textContent = t(error?.key || 'xle.error.request');
      if (error?.key === 'xle.error.session' || error?.key === 'xle.error.forbidden') {
        controller.abort(); characters = []; status = null;
        content.replaceChildren(element('p', t('xle.adminRequired')));
      } else if (!status) {
        content.replaceChildren(button(t('xle.refresh'), () => run(load), true));
      }
    }
    async function run(action) {
      if (busy || controller.signal.aborted) return;
      busy = true; feedback.textContent = t('xle.working');
      const controls = [...content.querySelectorAll('button, input, textarea')];
      const disabled = controls.map(el => el.disabled);
      controls.forEach(el => { el.disabled = true; });
      dialog.setAttribute('aria-busy', 'true');
      try { await action(); }
      catch (error) { if (panel?.dialog === dialog && !controller.signal.aborted) displayError(error); }
      finally {
        busy = false; dialog.removeAttribute('aria-busy');
        controls.forEach((el, index) => { el.disabled = disabled[index]; });
      }
    }
    function render() {
      content.replaceChildren();
      const summary = element('div', undefined, 'summary');
      summary.append(element('div', t(status.enabled ? 'xle.enabled' : 'xle.disabled')));
      for (const name of ['openai', 'xai']) {
        const p = status.providers[name];
        const card = element('div');
        card.append(element('h3', name === 'openai' ? 'OpenAI' : 'xAI'),
          element('div', t(p.configured ? 'xle.configured' : 'xle.notConfigured')),
          element('div', t(p.direct_egress_enabled ? 'xle.egressEnabled' : 'xle.egressBlocked'), 'muted'));
        summary.append(card);
      }
      content.append(summary);
      if (!status.enabled) content.append(element('p', t('xle.disabledHint'), 'notice'));
      if (Object.values(status.providers).some(p => p.direct_egress_enabled)) {
        content.append(element('p', t('xle.egressWarning'), 'notice'));
      }
      const tools = element('div', undefined, 'top');
      tools.append(element('h2', t('xle.characters')), button(t('xle.refresh'), () => run(load), true));
      content.append(tools);
      const grid = element('div', undefined, 'grid');
      for (const c of characters) {
        const card = element('article');
        card.append(element('h3', c.name), element('p', `${c.role} · ${c.provider}`, 'muted'),
          element('p', t(!c.enabled ? 'xle.characterDisabled' : c.provisioned ? 'xle.provisioned' : 'xle.notProvisioned')));
        if (c.channel_id) card.append(element('p', t('xle.boundChannel', { id: c.channel_id }), 'muted'));
        const actions = element('div', undefined, 'actions');
        const provision = button(t('xle.provision'), () => provisionForm(c));
        provision.disabled = !status.enabled || !c.enabled || c.provisioned;
        const preview = button(t('xle.preview'), () => previewForm(c), true);
        const p = status.providers[c.provider];
        preview.disabled = !status.enabled || !c.enabled || !p.configured || !p.direct_egress_enabled;
        actions.append(provision, preview); card.append(actions); grid.append(card);
      }
      content.append(grid);
      if (!characters.length) content.append(element('p', t('xle.empty'), 'muted'));
      const footer = element('footer');
      footer.append(element('h2', t('xle.configuration')), element('p', t('xle.configurationHint'), 'muted'),
        element('h3', t('xle.memory')), element('p', t('xle.memoryHint'), 'muted'));
      content.append(footer);
    }
    async function load() {
      // One deliberate refresh, two calls; no background API polling against
      // the foundation's shared 12-request/minute rate limit.
      const nextStatus = await client.status();
      const nextCharacters = await client.characters();
      if (nextCharacters.enabled !== nextStatus.enabled) throw { key: 'xle.error.changed' };
      status = nextStatus; characters = nextCharacters.characters;
      feedback.textContent = ''; render();
    }
    function formHeader(c, heading) {
      feedback.textContent = ''; content.replaceChildren();
      content.append(button(t('xle.back'), () => { feedback.textContent = ''; render(); }, true),
        element('h2', `${heading} · ${c.name}`));
    }
    function provisionForm(c) {
      formHeader(c, t('xle.provision'));
      const form = element('form');
      form.append(element('p', t('xle.provisionHint'), 'notice'));
      const label = element('label', t('xle.channelId'));
      const input = element('input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.required = true;
      label.append(input); form.append(label);
      const submit = element('button', t('xle.review')); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const channelId = Number(input.value);
        if (!Number.isSafeInteger(channelId) || channelId < 1) { displayError({ key: 'xle.error.channel' }); return; }
        formHeader(c, t('xle.review'));
        content.append(element('p', t('xle.confirmProvision', { name: c.name, id: channelId }), 'notice'));
        content.append(button(t('xle.createIdentity'), () => run(async () => {
          const updated = await client.provision(c.id, channelId);
          characters = characters.map(item => item.id === c.id ? updated : item);
          render(); feedback.textContent = t('xle.provisionSuccess');
        })));
      });
      content.append(form); input.focus();
    }
    function previewForm(c) {
      formHeader(c, t('xle.preview'));
      const form = element('form');
      form.append(element('p', t('xle.previewHint'), 'notice'));
      const label = element('label', t('xle.prompt'));
      const input = element('textarea'); input.maxLength = 1000; input.required = true;
      label.append(input); form.append(label);
      const submit = element('button', t('xle.sendPreview')); submit.type = 'submit';
      const output = element('pre'); output.hidden = true; output.setAttribute('aria-live', 'polite');
      form.append(submit); content.append(form, output);
      form.addEventListener('submit', event => {
        event.preventDefault();
        // Clear the previous result before making a new request.
        output.textContent = ''; output.hidden = true;
        run(async () => {
          const answer = await client.preview(c.id, input.value);
          output.textContent = answer; output.hidden = false; feedback.textContent = t('xle.previewSuccess');
        });
      });
      input.focus();
    }
    // Recheck the local session while open without making network requests.
    // Server endpoints independently recheck administrator privileges in DB.
    const watch = window.setInterval(() => {
      if (!controller.signal.aborted && !client.current()) displayError({ key: 'xle.error.session' });
    }, 500);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (panel?.dialog === dialog) close(); });
    dialog.showModal();
    if (client.current()) run(load);
    else displayError({ key: 'xle.error.session' });
  }
  return { open };
}

module.exports = { createXleClient, installXleAdmin };
