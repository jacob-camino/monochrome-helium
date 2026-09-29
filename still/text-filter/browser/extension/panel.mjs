const enabled = document.querySelector('#enabled');
const analyze = document.querySelector('#analyze');
const status = document.querySelector('#status');
const send = message => chrome.runtime.sendMessage({target: 'prototype', ...message});
const initial = await send({type: 'status'});
enabled.checked = initial.enabled;
analyze.disabled = !initial.enabled;
enabled.onchange = async () => {
  await send({type: 'enable', enabled: enabled.checked});
  analyze.disabled = !enabled.checked;
  status.textContent = enabled.checked ? 'Ready. Runs only when requested.' : 'Disabled';
};
analyze.onclick = async () => {
  analyze.disabled = true;
  status.textContent = 'Classifying locally…';
  const result = await send({type: 'classify-active-tab'});
  status.textContent = result.decision + (result.reason ? ' — ' + result.reason : '') +
    '. No blocking action was taken.';
  analyze.disabled = !enabled.checked;
};
