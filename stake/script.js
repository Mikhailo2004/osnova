document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('loaded');

  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const light = !document.body.classList.contains('light');
      document.body.classList.toggle('light', light);
      toggleBtn.textContent = light ? 'Темная тема' : 'Светлая тема';
    });
  }

  const cryptoIds = {
    usdc: 'usd-coin',
    usdt: 'tether',
    doge: 'dogecoin',
    ltc: 'litecoin',
    eth: 'ethereum',
    bnb: 'binancecoin'
  };

  function updatePrices() {
    const ids = Object.values(cryptoIds).join(',');
    fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)
      .then(r => r.json())
      .then(data => {
        for (const [short, id] of Object.entries(cryptoIds)) {
          const price = data[id]?.usd;
          if (price) {
            const el = document.querySelector(`#${short} .price`);
            if (el) el.textContent = `$${price}`;
          }
        }
      }).catch(() => {});
  }

  function updateClocks() {
    const now = new Date();
    const fmt = {hour: '2-digit', minute: '2-digit', second: '2-digit'};
    document.getElementById('clock-sg').textContent = now.toLocaleTimeString('en-US', { ...fmt, timeZone: 'Asia/Singapore' });
    document.getElementById('clock-ny').textContent = now.toLocaleTimeString('en-US', { ...fmt, timeZone: 'America/New_York' });
    document.getElementById('clock-cn').textContent = now.toLocaleTimeString('en-US', { ...fmt, timeZone: 'Asia/Shanghai' });
    document.getElementById('clock-af').textContent = now.toLocaleTimeString('en-US', { ...fmt, timeZone: 'Africa/Johannesburg' });
    document.getElementById('clock-ru').textContent = now.toLocaleTimeString('en-US', { ...fmt, timeZone: 'Europe/Moscow' });
  }

  const stakeBtn = document.getElementById('stake-button');
  if (stakeBtn) {
    stakeBtn.addEventListener('click', () => {
      fetch('track.php?event=stake');
    });
  }

  updatePrices();
  updateClocks();
  setInterval(updatePrices, 60000);
  setInterval(updateClocks, 1000);
});