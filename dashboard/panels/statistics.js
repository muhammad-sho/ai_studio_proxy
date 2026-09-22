(() => {
  const { api, esc, usageQuery } = window.dashboard;

  function statsPeriodChanged() {
    const specific = document.getElementById('statsPeriod').value === 'since';
    document.getElementById('statsMonthWrap').style.display = specific ? 'flex' : 'none';
    if (specific) {
      for (const id of ['statsFrom', 'statsTo']) {
        const input = document.getElementById(id);
        if (input && !input.value) input.value = window.dashboard.pacificToday();
      }
    }
    loadUsage();
  }

  window.statsPeriodChanged = statsPeriodChanged;
  window.loadUsage = loadUsage;
})();
