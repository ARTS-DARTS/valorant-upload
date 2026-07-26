const CYPHER_ICON =
  'https://media.valorant-api.com/agents/117ed9e3-49f3-6512-3ccf-0cada7e3823b/displayicon.png';

function setReactInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function enhanceTraining() {
  const agent = document.querySelector('.scenario .agent');
  if (agent && !agent.querySelector('img')) {
    agent.textContent = '';
    const image = document.createElement('img');
    image.src = CYPHER_ICON;
    image.alt = 'Cypher';
    agent.appendChild(image);
  }

  const title = document.querySelector(
    '.form-grid input[placeholder*="B Site Camera"]',
  );
  if (title && !title.dataset.automaticTitle) {
    title.dataset.automaticTitle = 'true';
    setReactInputValue(title, 'B Site Camera and Trapwires');
  }

  document.querySelectorAll('.quality p').forEach(paragraph => {
    if (paragraph.textContent?.includes('Название и описание понятны')) {
      paragraph.textContent = 'Описание материала и шаблон понятны.';
    }
    if (paragraph.textContent?.includes('Заполни название и подробное описание')) {
      paragraph.textContent = 'Выбери шаблон и подробно опиши материал.';
    }
  });
}

const observer = new MutationObserver(enhanceTraining);
observer.observe(document.getElementById('root'), {
  childList: true,
  subtree: true,
});
enhanceTraining();
