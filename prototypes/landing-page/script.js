const periods = {
  week: {
    spend: "Bs 4.820",
    leads: "146",
    cpl: "Bs 33,01",
    total: "146 leads",
    bars: [34, 55, 47, 72, 61, 88, 76],
  },
  month: {
    spend: "Bs 18.760",
    leads: "584",
    cpl: "Bs 32,12",
    total: "584 leads",
    bars: [52, 68, 61, 84, 73, 94, 87],
  },
};

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", () => {
    const period = periods[button.dataset.period];
    if (!period) return;
    document.querySelectorAll("[data-period]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    document.querySelector('[data-kpi="spend"]').textContent = period.spend;
    document.querySelector('[data-kpi="leads"]').textContent = period.leads;
    document.querySelector('[data-kpi="cpl"]').textContent = period.cpl;
    document.querySelector("[data-chart-total]").textContent = period.total;
    document.querySelectorAll(".bars i").forEach((bar, index) => {
      bar.style.setProperty("--h", `${period.bars[index]}%`);
    });
  });
});
