// @file approve.js — answers a sign-in approval from approve.html. The id and
// one-time secret arrive in the URL fragment (never sent to any server in a
// request line) and are POSTed to /api/approval.
(function () {
  var q = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname); // drop the secret from the URL bar/history
  var id = q.get('id'), secret = q.get('s');
  var $ = function (x) { return document.getElementById(x); };
  $('number').textContent = q.get('n') || '--';
  var bits = [];
  if (q.get('ip')) bits.push('From ' + q.get('ip'));
  if (q.get('at')) bits.push(new Date(q.get('at')).toLocaleTimeString());
  $('detail').textContent = bits.join(' · ');

  function done(text) {
    $('approve').disabled = $('deny').disabled = true;
    $('result').textContent = text;
  }
  if (!id || !secret) { done('This request link is incomplete.'); return; }

  function send(decision) {
    $('approve').disabled = $('deny').disabled = true;
    fetch('/api/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, secret: secret, decision: decision }),
    }).then(function (r) {
      done(r.ok ? (decision === 'approve' ? 'Approved. You can close this.' : 'Denied. Nobody got in.')
        : 'This request already ended or expired.');
    }).catch(function () { done('Could not reach PersaLink. Is Tailscale on?'); });
  }
  $('approve').addEventListener('click', function () { send('approve'); });
  $('deny').addEventListener('click', function () { send('deny'); });
})();
