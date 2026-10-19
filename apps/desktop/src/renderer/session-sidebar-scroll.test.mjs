import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 40;
const VIEWPORT_HEIGHT = 160;

for (const action of [
  'favorite-anchor',
  'unfavorite-anchor',
  'delete-anchor',
  'delete-above',
  'delete-last-favorite',
  'duplicate-project-row',
  'insert-at-top',
]) {
  test(`sidebar preserves the visible row position after ${action}`, async (t) => {
    const { root, document, window } = installTestDom(t, {
      rootId: 'root',
      expose: ['HTMLElement', 'CustomEvent'],
    });
    const { SessionSidebar } = await import('./session-sidebar.tsx');
    let sessions = Array.from({ length: 60 }, (_, index) => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      preview: '',
      updatedAt: 60 - index,
      activityAt: 60 - index,
      messageCount: 1,
      cwd: action === 'duplicate-project-row' ? '/project' : '',
      classification: 'task',
      projectPath: null,
      working: false,
      favorite: action === 'unfavorite-anchor' || (action === 'delete-last-favorite' && index === 0),
    }));
    const props = {
      open: true,
      sessionsReady: true,
      projects: action === 'duplicate-project-row' ? [{ name: 'Project', path: '/project', alias: null }] : [],
      selection: { kind: 'new' },
      onNewTask() {},
      onNewStudio() {},
      onResumeSession() {},
      async onRenameSession() {},
      async onArchiveSession() {},
      async onFavoriteSession() {},
      async onDeleteSession() {},
    };
    // jsdom has no layout. Model section headings and rows in DOM order,
    // including the distinct project and Recent copies of the same session.
    const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      const scroller = document.querySelector('.session-sidebar-sessions .session-sidebar-scroll');
      if (this === scroller) return { top: 0, bottom: VIEWPORT_HEIGHT };
      if (this.matches('.session-row[data-session-id]')) {
        let top = 0;
        for (const section of scroller.children) {
          top += HEADER_HEIGHT;
          for (const row of section.querySelectorAll('.session-row[data-session-id]')) {
            if (row === this) {
              return { top: top - scroller.scrollTop, bottom: top + ROW_HEIGHT - scroller.scrollTop };
            }
            top += ROW_HEIGHT;
          }
        }
      }
      if (this.matches('.session-list-sentinel')) return { top: 10000, bottom: 10000 };
      return originalRect.call(this);
    };
    t.after(() => {
      window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    });
    const render = () => act(async () => root.render(React.createElement(SessionSidebar, { ...props, sessions })));
    await render();
    const section = document.querySelector(
      action === 'unfavorite-anchor' ? '.sidebar-favorites' : 'section[aria-label="Recent sessions"]'
    );
    assert.ok(section);
    const anchor = section.querySelector('[data-session-id="session-10"]');
    const neighbor = section.querySelector('[data-session-id="session-11"]');
    const scroller = section.closest('.session-sidebar-scroll');
    scroller.scrollTop = anchor.getBoundingClientRect().top + 8;
    await act(async () => scroller.dispatchEvent(new window.Event('scroll')));
    const expectedOffset = neighbor.getBoundingClientRect().top;
    if (action === 'favorite-anchor' || action === 'duplicate-project-row') {
      sessions = sessions.map((session) => (session.id === 'session-10' ? { ...session, favorite: true } : session));
    } else if (action === 'unfavorite-anchor') {
      sessions = sessions.map((session) => (session.id === 'session-10' ? { ...session, favorite: false } : session));
    } else if (action === 'insert-at-top') {
      sessions = [{ ...sessions[0], id: 'new-session', activityAt: 100, updatedAt: 100 }, ...sessions];
    } else {
      const deletedId = action === 'delete-anchor' ? 'session-10' : 'session-0';
      sessions = sessions.filter((session) => session.id !== deletedId);
    }
    await render();
    assert.ok(scroller.scrollTop > 0, 'a catalog change must not jump to the top');
    assert.equal(
      neighbor.getBoundingClientRect().top,
      expectedOffset,
      'the next surviving row stays at its screen coordinate'
    );
    assert.equal(neighbor.isConnected, true, 'the existing row remains mounted');
  });
}
