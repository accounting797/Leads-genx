(function () {
  function createChipInput(element, options) {
    const selected = new Set();
    const suggestions = options.suggestions || [];
    const allowFree = element.dataset.free === 'true';
    const placeholder = element.dataset.placeholder || 'Select';

    element.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'chip-box';
    const input = document.createElement('input');
    input.placeholder = placeholder;
    const menu = document.createElement('div');
    menu.className = 'chip-menu';
    box.append(input, menu);
    element.appendChild(box);

    function renderChips() {
      box.querySelectorAll('.chip').forEach((chip) => chip.remove());
      Array.from(selected).forEach((value) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = value;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'x';
        remove.addEventListener('click', () => {
          selected.delete(value);
          renderChips();
          renderMenu();
        });
        chip.appendChild(remove);
        box.insertBefore(chip, input);
      });
      input.placeholder = selected.size ? '' : placeholder;
    }

    function add(value) {
      const clean = String(value || '').trim();
      if (!clean) return;
      selected.add(clean);
      input.value = '';
      renderChips();
      renderMenu();
    }

    function renderMenu() {
      const q = input.value.trim().toLowerCase();
      const matches = suggestions
        .filter((item) => item.toLowerCase().includes(q))
        .filter((item) => !selected.has(item))
        .slice(0, 30);
      menu.innerHTML = '';
      matches.forEach((item) => {
        const btn = document.createElement('button');
        btn.className = 'chip-option';
        btn.type = 'button';
        btn.textContent = item;
        btn.addEventListener('click', () => add(item));
        menu.appendChild(btn);
      });
      menu.classList.toggle('open', matches.length > 0);
    }

    input.addEventListener('focus', renderMenu);
    input.addEventListener('input', renderMenu);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (allowFree) add(input.value);
        else if (menu.firstChild) menu.firstChild.click();
      }
      if (event.key === 'Backspace' && !input.value && selected.size) {
        const values = Array.from(selected);
        selected.delete(values[values.length - 1]);
        renderChips();
      }
    });

    document.addEventListener('click', (event) => {
      if (!element.contains(event.target)) menu.classList.remove('open');
    });

    return {
      getValue: () => Array.from(selected),
      setSuggestions(values) {
        suggestions.splice(0, suggestions.length, ...(values || []));
        renderMenu();
      },
      clear() {
        selected.clear();
        renderChips();
      },
    };
  }

  window.LeadsGenXChips = { createChipInput };
})();
