import { FrameSequence, clamp, progressToFrame, scrollProgress, chapterAt } from './sequence.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const smallScreen = window.matchMedia('(max-width: 760px)');
const section = $('.journey');
const stage = $('#stage');
const canvas = $('#aircraft-canvas');
const context = canvas.getContext('2d', { alpha: false });
const poster = $('#stage-poster');
const status = $('#sequence-status');
const progressBar = $('#journey-progress');
const panels = Object.fromEntries($$('[data-panel]').map((panel) => [panel.dataset.panel, panel]));
let sequence;
let displayProgress = 0;
let targetProgress = 0;
let tickScheduled = false;
let lastRequestedFrame = -1;
let lastChapter = -1;
let viewport = { width: 0, height: 0, dpr: 1 };

function smoothstep(from, to, value) {
  const x = clamp((value - from) / (to - from));
  return x * x * (3 - 2 * x);
}

function blend(a, b, amount) {
  return a + (b - a) * amount;
}

function requestTick() {
  if (tickScheduled) return;
  tickScheduled = true;
  requestAnimationFrame(tick);
}

function sizeCanvas() {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, smallScreen.matches ? 1.5 : 2);
  if (viewport.width !== width || viewport.height !== height || viewport.dpr !== dpr) {
    viewport = { width, height, dpr };
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
}

function drawScene() {
  if (!context) return;
  const picture = sequence?.current() || (poster.complete && poster.naturalWidth ? poster : null);
  if (!picture) return;
  const { width, height, dpr } = viewport;
  const openAmount =
    smoothstep(0.4, 0.53, displayProgress) * (1 - smoothstep(0.8, 0.98, displayProgress));
  const mobile = smallScreen.matches;
  const imageWidth = mobile
    ? blend(Math.min(width * 1.72, height * 1.12), width * 1.04, openAmount)
    : blend(Math.min(width * 1.0, height * 1.75), Math.min(width * 0.96, height * 1.6), openAmount);
  const imageHeight = (imageWidth * 720) / 1280;
  const centerX = width * (mobile ? 0.51 : blend(0.68, 0.5, openAmount));
  const centerY = height * (mobile ? blend(0.6, 0.65, openAmount) : blend(0.54, 0.65, openAmount));
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = '#101010';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const x = centerX - imageWidth / 2;
  const y = centerY - imageHeight / 2;
  context.drawImage(picture, x, y, imageWidth, imageHeight);
  // Blend the filmed studio floor into the page, regardless of canvas framing.
  const featherX = Math.min(imageWidth * 0.13, 125);
  const featherY = Math.min(imageHeight * 0.2, 115);
  const edges = [
    [x, y, x, y + featherY, x, y, imageWidth, featherY],
    [
      x,
      y + imageHeight,
      x,
      y + imageHeight - featherY,
      x,
      y + imageHeight - featherY,
      imageWidth,
      featherY,
    ],
    [x, y, x + featherX, y, x, y, featherX, imageHeight],
    [
      x + imageWidth,
      y,
      x + imageWidth - featherX,
      y,
      x + imageWidth - featherX,
      y,
      featherX,
      imageHeight,
    ],
  ];
  for (const [x1, y1, x2, y2, left, top, edgeWidth, edgeHeight] of edges) {
    const gradient = context.createLinearGradient(x1, y1, x2, y2);
    gradient.addColorStop(0, '#101010');
    gradient.addColorStop(1, 'rgba(16,16,16,0)');
    context.fillStyle = gradient;
    context.fillRect(left, top, edgeWidth, edgeHeight);
  }
  $('.stage-vignette').style.opacity = String(blend(1, 0.35, openAmount));
  canvas.dataset.frame = String(motionPreference.matches ? 0 : progressToFrame(displayProgress));
  stage.classList.add('has-canvas');
}

function showPanel(panel, opacity) {
  const visible = opacity > 0.08;
  panel.style.opacity = String(opacity);
  panel.style.transform = motionPreference.matches ? 'none' : `translateY(${(1 - opacity) * 12}px)`;
  panel.setAttribute('aria-hidden', String(!visible));
  panel.inert = !visible;
  panel.style.pointerEvents = visible ? 'auto' : 'none';
}

function updateNarrative(progress) {
  showPanel(panels.intro, 1 - smoothstep(0.045, 0.15, progress));
  showPanel(
    panels.orbit,
    smoothstep(0.11, 0.19, progress) * (1 - smoothstep(0.35, 0.42, progress)),
  );
  showPanel(
    panels.exploded,
    smoothstep(0.435, 0.49, progress) * (1 - smoothstep(0.7, 0.765, progress)),
  );
  showPanel(panels.assembly, smoothstep(0.765, 0.845, progress));
  progressBar.style.transform = `scaleX(${progress})`;
  const chapter = chapterAt(progress);
  if (chapter !== lastChapter) {
    lastChapter = chapter;
    stage.dataset.chapter = String(chapter);
    $('#scene-number').textContent = String(chapter + 1).padStart(2, '0');
    $$('.chapter-button').forEach((button, index) => {
      button.classList.toggle('is-active', index === chapter);
      if (index === chapter) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
  }
}

function tick() {
  tickScheduled = false;
  sizeCanvas();
  targetProgress = scrollProgress(
    section.getBoundingClientRect().top,
    section.offsetHeight,
    stage.offsetHeight,
  );
  displayProgress = motionPreference.matches
    ? targetProgress
    : blend(displayProgress, targetProgress, 0.19);
  if (Math.abs(targetProgress - displayProgress) < 0.0003) displayProgress = targetProgress;
  const frame = progressToFrame(displayProgress);
  if (sequence && lastRequestedFrame !== frame) {
    lastRequestedFrame = frame;
    sequence.setTarget(frame);
  }
  updateNarrative(displayProgress);
  drawScene();
  if (displayProgress !== targetProgress) requestTick();
}

function configureSequence() {
  sequence?.destroy();
  sequence = null;
  lastRequestedFrame = -1;
  if (motionPreference.matches || !context) {
    status.textContent =
      'Статичный режим: анимация отключена в соответствии с настройками уменьшенного движения.';
  } else {
    sequence = new FrameSequence({
      variant: smallScreen.matches ? 'mobile' : 'desktop',
      base: import.meta.env.BASE_URL,
      concurrency: navigator.connection?.saveData ? 2 : 4,
      onFrame: requestTick,
      onProgress: (loaded, total) => {
        if (loaded === total)
          status.textContent = 'Анимация готова. Прокрутите страницу, чтобы рассмотреть аппарат.';
      },
    });
    sequence.start();
  }
  requestTick();
}

function goToChapter(progress) {
  const offset = section.getBoundingClientRect().top + window.scrollY;
  const top = offset + progress * (section.offsetHeight - stage.offsetHeight);
  window.scrollTo({ top, behavior: motionPreference.matches ? 'instant' : 'smooth' });
}

window.addEventListener('scroll', requestTick, { passive: true });
window.addEventListener('resize', requestTick, { passive: true });
poster.addEventListener('load', requestTick);
motionPreference.addEventListener('change', configureSequence);
smallScreen.addEventListener('change', configureSequence);
$$('[data-chapter-target]').forEach((button) =>
  button.addEventListener('click', () => goToChapter(Number(button.dataset.chapterTarget))),
);
$('#scroll-cue').addEventListener('click', () => goToChapter(Math.min(targetProgress + 0.2, 0.91)));
configureSequence();

const menuButton = $('.menu-toggle');
const navigation = $('#navigation');
function closeMenu() {
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Открыть меню');
  navigation.classList.remove('is-open');
}
menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
  navigation.classList.toggle('is-open', open);
});
$$('a', navigation).forEach((anchor) => anchor.addEventListener('click', closeMenu));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menuButton.focus();
  }
});

const componentPanels = $$('[data-component-panel]');
const hotspots = $$('[data-component]');
let syncingComponents = false;
function selectComponent(key) {
  syncingComponents = true;
  componentPanels.forEach((panel) => {
    panel.open = panel.dataset.componentPanel === key;
  });
  hotspots.forEach((button) => {
    const selected = button.dataset.component === key;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  queueMicrotask(() => {
    syncingComponents = false;
  });
}
hotspots.forEach((button) => {
  button.addEventListener('click', () => selectComponent(button.dataset.component));
  button.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') selectComponent(button.dataset.component);
  });
});
componentPanels.forEach((panel) => {
  $('summary', panel).addEventListener('click', (event) => {
    event.preventDefault();
    selectComponent(panel.dataset.componentPanel);
  });
  panel.addEventListener('toggle', () => {
    if (panel.open && !syncingComponents) {
      hotspots.forEach((button) => {
        const selected = button.dataset.component === panel.dataset.componentPanel;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
    }
  });
});

const configDialog = $('#config-dialog');
const configForm = $('#config-form');
const filmDialog = $('#film-dialog');
const film = $('#product-film');
let dialogOpener;
let toastTimer;
const kitDescriptions = {
  Базовый: 'Аппарат, живой модуль и паспорт конструкции.',
  Расширенный: 'Базовый комплект, транспортировочный чехол и набор для ухода за живым модулем.',
};
const missions = ['Обзор', 'Экспедиция', 'Индивидуальная задача'];
const kits = Object.keys(kitDescriptions);

function getConfiguration() {
  const data = new FormData(configForm);
  return { mission: data.get('mission'), kit: data.get('kit') };
}

function updateConfiguration() {
  const configuration = getConfiguration();
  $('#config-summary').textContent = `КЕДР 01 / ${configuration.mission} / ${configuration.kit}`;
  $('#kit-description').textContent = kitDescriptions[configuration.kit];
  try {
    localStorage.setItem('kedr-configuration', JSON.stringify(configuration));
  } catch {
    /* Private browsing still supports configuration and downloading. */
  }
}

try {
  const saved = JSON.parse(localStorage.getItem('kedr-configuration') || 'null');
  if (saved && missions.includes(saved.mission) && kits.includes(saved.kit)) {
    $$('input[type=radio]', configForm).forEach((input) => {
      input.checked = input.value === saved[input.name];
    });
  }
} catch {
  /* Ignore damaged or unavailable local preferences. */
}
updateConfiguration();
configForm.addEventListener('change', updateConfiguration);

function openDialog(dialog, opener) {
  closeMenu();
  dialogOpener = opener;
  dialog.showModal();
  document.body.classList.add('dialog-open');
}

function onDialogClose() {
  document.body.classList.remove('dialog-open');
  dialogOpener?.focus({ preventScroll: true });
}

$$('[data-open-config]').forEach((button) =>
  button.addEventListener('click', () => openDialog(configDialog, button)),
);
$('[data-close-config]').addEventListener('click', () => configDialog.close());
configDialog.addEventListener('close', onDialogClose);
$$('[data-open-film]').forEach((button) =>
  button.addEventListener('click', () => {
    openDialog(filmDialog, button);
    if (!film.getAttribute('src')) film.src = `${import.meta.env.BASE_URL}media/film.mp4`;
    film
      .play()
      .then(() => {
        if (!filmDialog.open) film.pause();
      })
      .catch(() => {
        /* Native controls remain available if autoplay is restricted. */
      });
  }),
);
function closeFilm() {
  film.pause();
  filmDialog.close();
}
$('[data-close-film]').addEventListener('click', closeFilm);
filmDialog.addEventListener('cancel', () => film.pause());
filmDialog.addEventListener('close', () => {
  film.pause();
  onDialogClose();
});
for (const dialog of [configDialog, filmDialog]) {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    ) {
      if (dialog === filmDialog) closeFilm();
      else dialog.close();
    }
  });
}

configForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const { mission, kit } = getConfiguration();
  const documentText = [
    'КЕДР 01',
    'Индивидуальная спецификация',
    '',
    `Сценарий: ${mission}`,
    `Комплект: ${kit}`,
    `Состав: ${kitDescriptions[kit]}`,
    'Исполнение: оригинальное сине-жёлтое, живой хвойный модуль.',
    '',
    'Основные узлы: винтовой блок, открытый металлический каркас, цилиндрический корпус, живой модуль, трубчатые посадочные опоры.',
    '',
    'КЕДР 01 — концептуальный проект. Этот документ сохраняет выбранную конфигурацию и не является заказом или подтверждением лётных характеристик.',
  ].join('\r\n');
  const url = URL.createObjectURL(
    new Blob(['\uFEFF', documentText], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'KEDR-01-specification.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const toast = $('#toast');
  toast.textContent = 'Спецификация готова к сохранению';
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 4500);
});

window.addEventListener('pagehide', () => sequence?.destroy());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) configureSequence();
});
