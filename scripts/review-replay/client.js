'use strict';
(() => {
  const { manifest, generatedAt } = JSON.parse(document.getElementById('evidence-data').textContent);
  const byId = id => document.getElementById(id);
  const text = value => typeof value === 'string' ? value : value === null ? '未知 / 未建立' : typeof value === 'boolean' ? value ? '是' : '否' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const element = (tag, content, className) => { const node = document.createElement(tag); if (content !== undefined) node.textContent = text(content); if (className) node.className = className; return node; };
  const env = claim => claim.environment?.kind === 'local-anvil' ? 'local' : 'offline';
  const envNames = { local: '本地 Anvil · 受控环境', offline: '离线演示 · 合成记录' };
  const versions = { final: '最终记录', earlier: '早期版本', historical: '历史记录' };
  const fields = { cashAfterRaw: '结余现金', cashRaw: '现金', taskRevenueRaw: '任务收入', inferenceCostRaw: '净服务支出', borrowingFeeRaw: '借款费用', netOperatingRaw: '结算贡献（不含链费）', refundsRaw: '退款', chargedRaw: '净支出', operatingResultRaw: '结算贡献（不含链费）', grossReceiptsRaw: '供应商收款', netReceiptsRaw: '供应商净收款', startupCapitalRaw: '启动资本', gameSubsidyRaw: '游戏奖补', debtRaw: '未偿债务', debtAfterRaw: '结束时债务', replayAddedCalls: '恢复新增调用', totalChargedRaw: '总支出', taskCount: '任务数', modelCalls: '模型调用次数', taskId: '任务 ID', requestId: '请求 ID', paymentId: '付款 ID', txHash: '交易哈希', originalJournalsUnchanged: '原始记录未改动', extraPayments: '新增付款', stopReason: '停止原因' };
  const titles = {
    'Local economic lifecycle': '完整本地经营与退款',
    'Independent publisher / Worker consumer': '独立发布方与 Worker 接入', 'Controlled strategy feedback': '离线策略反馈演示',
    'Independent publisher and bounded Worker process recovery': '独立发布 → 受限经营 → 进程恢复 → 继续经营',
    'Independent Worker default shadow observation': '独立 Worker · 默认只读观察',
    'Fresh local acceptance observation': '本次 CI / 本地复验记录',
    'Read-only decision feedback': '实际结果 → 只读策略建议', 'Controlled role contribution and runway': '离线角色经营与补贴续航',
    'Default bounded shadow observation': '默认只读：观察候选与现金储备',
    'Bounded local decision → execution → feedback': '真实候选 → 决策 → 执行 → 结果 → 再决策',
    'Agent / platform / supplier accounting': 'Agent、平台与供应商经营核算'
  };
  const title = claim => titles[claim.title] || claim.title || claim.capabilityId || claim.id;
  const dateOf = claim => Number(claim.reportId?.match(/20\d{6}/)?.[0] || 0);
  const priority = claim => claim.capabilityId === 'economy.independent-bounded-process-recovery' ? 2 : claim.capabilityId === 'economy.bounded-feedback-execution' ? 1 : 0;
  const orderedClaims = [...manifest.claims].sort((a, b) => dateOf(b) - dateOf(a) || priority(b) - priority(a) || (a.evidenceStatus === 'earlier') - (b.evidenceStatus === 'earlier') || (b.evidenceStatus === 'final') - (a.evidenceStatus === 'final'));

  const labels = key => fields[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2');
  let selectedId, selectedEvent = 0;
  function flatten(value, path = '', depth = 0) {
    if (value === null || typeof value !== 'object') return [[path, value]];
    if (depth >= 3) return [[path, value]];
    return Object.entries(value).flatMap(([key, child]) => flatten(child, path ? `${path}.${key}` : key, depth + 1));
  }
  function money(raw) {
    if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return null;
    const value = BigInt(raw), abs = value < 0n ? -value : value;
    return `${value < 0n ? '−' : ''}${abs / 1000000n}.${(abs % 1000000n).toString().padStart(6, '0')} USDC`;
  }
  const monetary = key => /(?:cash|cost|fee|revenue|refund|charged|receipt|capital|subsidy|principal|profit|reward|debt|operating|spend|repai|balance|budget|loss|reserve).*Raw$/i.test(key) && !/token|credit(s|grant)|gas|native/i.test(key);
  function facts(value, max = 16) {
    const grid = element('dl', undefined, 'facts');
    for (const [path, valueAtPath] of flatten(value ?? {}).slice(0, max)) {
      const key = path.split('.').at(-1), row = element('div', undefined, 'fact');
      row.append(element('dt', labels(path.includes('.') ? path : key)));
      const formatted = monetary(path) ? money(valueAtPath) : null, dd = element('dd', formatted ?? text(valueAtPath));
      if (formatted) dd.append(element('span', `${valueAtPath} raw`, 'raw'));
      row.append(dd); grid.append(row);
    }
    return grid;
  }
  function section(article, heading) { article.append(element('h3', heading, 'section-title')); }
  function rawDetails(heading, value) { const node = element('details', undefined, 'raw-details'); node.append(element('summary', heading), element('pre', JSON.stringify(value, null, 2))); return node; }
  function timelineFor(claim) { return Array.isArray(claim.timeline) ? claim.timeline : manifest.timeline.filter(event => event.claimId === claim.id); }
  function sourceFor(claim) { return manifest.sources.find(source => source.id === claim.reportId || source.reportId === claim.reportId || source.file === claim.source?.file) ?? {}; }
  function showDetail(claim) {
    const article = byId('detail'); article.replaceChildren();
    if (!claim) { article.append(element('p', '没有匹配的证据。可以更换环境筛选或搜索词。', 'empty')); return; }
    const category = env(claim), badge = element('span', envNames[category], `tag ${category}`);
    article.append(badge, element('span', versions[claim.evidenceStatus] || claim.evidenceStatus || '已登记证据', 'version'), element('h2', title(claim)), element('p', claim.summary || '下面的事实来自这一场景的保存记录。', 'detail-summary'));
    if (claim.evidenceStatus === 'earlier') article.append(element('p', '这是保留的早期实现记录。请结合最终版本查看；其源码指纹不代表当前实现。', 'notice'));
    article.append(facts(claim.checkedFacts));
    if (Array.isArray(claim.checkedFacts?.decisions)) {
      section(article, '实际结果如何改变下一次选择');
      article.append(element('p', '每行是一次实际选择。反事实列保留相同候选和政策，只移除对应历史结果，用来核对反馈是否影响决策。', 'command-note'));
      const wrap = element('div', undefined, 'decision-table'), table = element('table'), header = element('tr');
      for (const heading of ['轮次', '实际任务', '实际结果', '移除成功历史', '移除失败历史', '结束现金']) { const th = element('th', heading); th.scope = 'col'; header.append(th); }
      const head = element('thead'); head.append(header); table.append(head); const body = element('tbody');
      const phases = { Succeeded: '成功', Failed: '付费失败', Paused: 'Unknown · 暂停', Refunded: '原付款退款 · 任务关闭' };
      for (const decision of claim.checkedFacts.decisions) { const row = element('tr'); for (const value of [decision.round, decision.taskId, phases[decision.phase] || decision.phase, decision.selectedWithoutSuccessTaskId, decision.selectedWithoutFailureTaskId, money(decision.cashAfterRaw) ?? decision.cashAfterRaw]) row.append(element('td', value)); body.append(row); }
      table.append(body); wrap.append(table); article.append(wrap);
    }
    if (flatten(claim.checkedFacts ?? {}).length > 16) article.append(rawDetails('展开全部已核对事实', claim.checkedFacts));
    section(article, '过程回放');
    const events = timelineFor(claim), timeline = element('div', undefined, 'timeline'), detail = element('div', undefined, 'event-detail');
    if (!events.length) article.append(element('p', '此证据没有登记逐步时间线，下面保留其完整核对事实和来源。', 'empty'));
    else {
      selectedEvent = Math.min(selectedEvent, events.length - 1);
      const displayEvent = index => {
        selectedEvent = index; for (const [i, button] of [...timeline.children].entries()) button.setAttribute('aria-current', String(i === index));
        const event = events[index]; detail.replaceChildren(element('p', event.description || event.title || event.type || event.id));
        const values = Object.fromEntries(Object.entries(event).filter(([key]) => !['description', 'title', 'claimId', 'reportId'].includes(key)));
        detail.append(facts(values, 10)); if (flatten(values).length > 10) detail.append(rawDetails('展开此步骤记录', values));
      };
      events.forEach((event, i) => { const button = element('button', undefined, 'event-button'); button.type = 'button'; button.append(element('span', String(i + 1).padStart(2, '0'), 'event-number'), element('span', event.title || event.type || event.id)); button.addEventListener('click', () => displayEvent(i)); timeline.append(button); });
      article.append(timeline, detail); displayEvent(selectedEvent);
    }
    section(article, '如何复验');
    article.append(element('pre', claim.reproductionCommand || 'npm run review:check', 'command'), element('p', '命令仅供查看和复制，本页不会执行。需要 Foundry / Docker 的本地集成与离线检查分别运行。', 'command-note'));
    section(article, '这份证据的边界');
    const list = element('ul', undefined, 'scope-list');
    for (const item of Array.isArray(claim.limitations) ? claim.limitations : []) list.append(element('li', item));
    if (!list.children.length) list.append(element('li', '核对保存记录不等于重新查询链上交易或验证上游账单。'));
    article.append(list);
    section(article, '来源与版本');
    const source = sourceFor(claim), grid = element('dl', undefined, 'source-grid');
    for (const [key, value] of [['能力声明', claim.id], ['报告路径', claim.source?.file || source.file || '未登记'], ['报告 SHA256', claim.source?.sha256 || source.sha256 || '未登记'], ['环境', claim.environment], ['实现版本', claim.implementation?.revision || source.implementation?.revision || '见原始报告'], ['版本口径', claim.implementation?.semantics || '原始报告描述当时的实现；不回填历史记录。']]) grid.append(element('dt', key), element('dd', value));
    article.append(grid, rawDetails('查看源码指纹与范围', { implementation: claim.implementation, scope: claim.scope, bindings: claim.bindings }));
  }
  function renderList() {
    const query = byId('search').value.trim().toLowerCase(), category = byId('environment').value, earlier = byId('include-earlier').checked;
    const visible = orderedClaims.filter(claim => (earlier || claim.evidenceStatus !== 'earlier') && (category === 'all' || env(claim) === category) && (!query || [title(claim), claim.title, claim.summary, claim.id, claim.capabilityId, claim.source?.file].some(value => String(value ?? '').toLowerCase().includes(query))));
    if (!visible.some(claim => claim.id === selectedId)) { selectedId = visible[0]?.id; selectedEvent = 0; }
    const list = byId('claim-list'); list.replaceChildren(); byId('result-count').textContent = `${visible.length} 项`;
    for (const claim of visible) {
      const button = element('button', undefined, 'claim-button'); button.type = 'button'; button.setAttribute('aria-current', String(claim.id === selectedId));
      button.append(element('span', envNames[env(claim)], `tag ${env(claim)}`), element('span', title(claim), 'claim-title'), element('span', claim.id, 'claim-id'));
      button.addEventListener('click', () => { selectedId = claim.id; selectedEvent = 0; renderList(); }); list.append(button);
    }
    if (!visible.length) list.append(element('p', '没有匹配的场景', 'empty'));
    showDetail(visible.find(claim => claim.id === selectedId));
  }
  const categories = [{ count: manifest.claims.filter(claim => claim.evidenceStatus !== 'earlier').length, title: '能力声明', note: '已登记并检查' }, ...Object.entries(envNames).map(([category, name]) => ({ count: new Set(manifest.claims.filter(claim => env(claim) === category && claim.evidenceStatus !== 'earlier').map(claim => claim.reportId)).size, title: name.split(' · ')[0], note: `${name.split(' · ')[1]} · 报告数` }))];
  for (const metric of categories) { const row = element('div', undefined, 'metric'), label = element('span', undefined, 'metric-label'); label.append(element('strong', metric.title), document.createTextNode(metric.note)); row.append(element('span', metric.count, 'metric-number'), label); byId('metrics').append(row); }
  byId('export-time').textContent = `页面导出时间：${generatedAt}`;
  for (const id of ['search', 'environment', 'include-earlier']) byId(id).addEventListener(id === 'search' ? 'input' : 'change', renderList);
  renderList();
})();
