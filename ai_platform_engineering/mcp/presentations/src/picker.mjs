export function normalizeTeamText(value) { return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[\s_.-]+/g, ' ').trim(); }
export function rankTeams(teams, query, selected = [], limit = 20) {
  const needle = normalizeTeamText(query), tokens = needle.split(/\s+/u);
  const chosen = new Set(selected);
  const matches = teams.flatMap(team => {
    const name = normalizeTeamText(team.name || team.slug), slug = normalizeTeamText(team.slug);
    if (!needle && !chosen.has(team.slug)) return [];
    if (needle && !tokens.every(token => `${name} ${slug}`.includes(token))) return [];
    const score = !needle ? 0 : [name, slug].some(value => value === needle) ? 0 : [name, slug].some(value => value.startsWith(needle)) ? 1 : 2;
    return [{ team, score }];
  }).sort((a, b) => a.score - b.score || (a.team.name || a.team.slug).localeCompare(b.team.name || b.team.slug) || a.team.slug.localeCompare(b.team.slug));
  return { options: matches.slice(0, limit).map(item => item.team), total: matches.length };
}
export function teamLabel(team) { return team.name?.trim() || team.slug; }
export function teamDescription(team) { return !team.name?.trim() || normalizeTeamText(team.name) === normalizeTeamText(team.slug) ? '' : team.slug; }

// The standalone iframe cannot import the host's React/Radix controls. This DOM
// adapter follows the host SearchablePicker focus, listbox and keyboard contract.
export function createSearchablePicker({ root, getOptions, getSelected, getValueLabel, onSelect, multiple = false, isDisabled = () => false }) {
  const trigger = root.querySelector('[data-trigger]');
  const value = root.querySelector('[data-value]');
  const popup = root.querySelector('[data-popup]');
  const query = popup.querySelector('input');
  const list = popup.querySelector('[role=listbox]');
  const status = popup.querySelector('[role=status]');
  const dialog = root.closest('dialog');
  // Keep it inside the modal's focus boundary; use the top layer to avoid clipping.
  dialog.append(popup);
  if (typeof popup.showPopover === 'function') popup.setAttribute('popover', 'manual');
  let opened = false, visible = [], active = -1;
  function position() {
    if (!opened) return;
    const rect = trigger.getBoundingClientRect(), margin = 12;
    const below = window.innerHeight - rect.bottom - margin - 6, above = rect.top - margin - 6;
    const upward = below < 220 && above > below;
    const width = Math.min(Math.max(rect.width, 280), window.innerWidth - margin * 2);
    Object.assign(popup.style, { width: width + 'px', left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)) + 'px', top: upward ? 'auto' : rect.bottom + 6 + 'px', bottom: upward ? window.innerHeight - rect.top + 6 + 'px' : 'auto', maxHeight: Math.max(80, Math.min(340, upward ? above : below)) + 'px' });
  }
  function activate(index) {
    active = index;
    [...list.children].forEach((option, i) => option.dataset.active = String(i === active));
    if (active < 0) query.removeAttribute('aria-activedescendant');
    else { query.setAttribute('aria-activedescendant', list.children[active].id); list.children[active].scrollIntoView({ block: 'nearest' }); }
  }
  function close(restore = true) {
    if (!opened) return;
    opened = false;
    if (typeof popup.hidePopover === 'function' && popup.matches(':popover-open')) popup.hidePopover();
    popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); query.removeAttribute('aria-activedescendant');
    if (restore) trigger.focus({ preventScroll: true });
  }
  function choose(team) {
    if (!team || isDisabled(team)) return;
    onSelect(team); update();
    if (multiple) { render(); query.focus({ preventScroll: true }); } else close();
  }
  function render() {
    const result = getOptions(query.value);
    visible = result.options;
    list.replaceChildren();
    for (const [i, team] of visible.entries()) {
      const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
      option.id = list.id + '-' + i; option.className = 'picker-option'; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(getSelected().includes(team.slug))); option.setAttribute('aria-disabled', String(isDisabled(team)));
      const labels = document.createElement('span'), label = document.createElement('span'); label.className = 'picker-label'; label.textContent = teamLabel(team); labels.append(label);
      if (teamDescription(team)) { const slug = document.createElement('span'); slug.className = 'picker-slug'; slug.textContent = teamDescription(team); labels.append(slug); }
      const check = document.createElement('span'); check.className = 'picker-check'; check.textContent = getSelected().includes(team.slug) ? '✓' : ''; check.setAttribute('aria-hidden', 'true'); option.append(labels, check);
      option.addEventListener('pointerdown', event => event.preventDefault()); option.addEventListener('click', () => choose(team)); list.append(option);
    }
    const searching = Boolean(query.value.trim());
    status.textContent = !searching ? 'Type to search teams by name or slug.' : !result.total ? 'No teams match your search.' : result.total > visible.length ? 'Showing ' + visible.length + ' of ' + result.total + ' matches. Keep typing to narrow your search.' : result.total + (result.total === 1 ? ' matching team' : ' matching teams');
    position(); activate(searching ? visible.findIndex(team => !isDisabled(team)) : -1);
  }
  function open() {
    if (opened || trigger.disabled) return;
    opened = true; query.value = ''; popup.hidden = false;
    if (typeof popup.showPopover === 'function') popup.showPopover();
    trigger.setAttribute('aria-expanded', 'true'); render(); query.focus({ preventScroll: true });
  }
  function update() { value.textContent = getValueLabel(); }
  trigger.addEventListener('click', () => opened ? close() : open());
  trigger.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); const enabled = visible.map((team, i) => !isDisabled(team) ? i : -1).filter(i => i >= 0); activate((event.key === 'ArrowUp' ? enabled.at(-1) : enabled[0]) ?? -1); } });
  query.addEventListener('input', render);
  query.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') {
      event.preventDefault(); close();
      const fields = [...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(el => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length);
      const next = (fields.indexOf(trigger) + (event.shiftKey ? -1 : 1) + fields.length) % fields.length; fields[next]?.focus();
    } else if (event.key === 'Enter') { event.preventDefault(); if (active >= 0) choose(visible[active]); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const enabled = visible.map((team, i) => !isDisabled(team) ? i : -1).filter(i => i >= 0);
      const at = enabled.indexOf(active);
      activate((event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : event.key === 'ArrowDown' ? enabled[(at + 1) % enabled.length] : enabled[at <= 0 ? enabled.length - 1 : at - 1]) ?? -1);
    }
  });
  document.addEventListener('pointerdown', event => { if (opened && !root.contains(event.target) && !popup.contains(event.target)) close(false); });
  dialog.addEventListener('close', () => close(false));
  window.addEventListener('resize', position); window.addEventListener('scroll', position, { capture: true, passive: true });
  update();
  return { update, close: () => close(false), focus: () => trigger.focus() };
}
