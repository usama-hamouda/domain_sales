/**
 * Reusable data table with sticky domain column, sort, column reorder, row selection.
 */
class DataTable {
  constructor(container, options = {}) {
    this.container = container;
    this.columns = options.columns || [];
    this.rows = options.rows || [];
    this.stickyKey = options.stickyKey || "domain";
    this.stickyKeys = options.stickyKeys || null;
    this.sortable = options.sortable !== false;
    this.selectable = options.selectable !== false;
    this.onSelectionChange = options.onSelectionChange || (() => {});
    this.onRowAction = options.onRowAction || null;
    this.rowActions = options.rowActions || [];
    this.rowClass = options.rowClass || null;
    this.sortCol = null;
    this.sortDir = "asc";
    this.selected = new Set();
    this._render();
  }

  setData(rows, columns) {
    if (columns) this.columns = columns;
    this.rows = rows;
    this.selected.clear();
    this._render();
  }

  getSelectedIds() {
    return [...this.selected];
  }

  _stickyKeys() {
    if (this.stickyKeys?.length) {
      return this.stickyKeys.filter((k) => this.columns.some((c) => c.key === k));
    }
    if (this.stickyKey) return [this.stickyKey];
    return [];
  }

  _stickyStyle(colKey) {
    const keys = this._stickyKeys();
    const stickyIndex = keys.indexOf(colKey);
    if (stickyIndex < 0) return null;

    let left = this.selectable ? 36 : 0;
    for (let i = 0; i < stickyIndex; i++) {
      const prevCol = this.columns.find((c) => c.key === keys[i]);
      left += prevCol?.stickyWidth ?? 120;
    }

    const col = this.columns.find((c) => c.key === colKey);
    const parts = [`left:${left}px`, `z-index:${4 + stickyIndex}`];
    if (col?.stickyWidth) parts.push(`min-width:${col.stickyWidth}px`, `max-width:${col.stickyWidth}px`);
    return parts.join(";");
  }

  _isSticky(colKey) {
    return this._stickyKeys().includes(colKey);
  }

  _render() {
    const sorted = this._sortedRows();
    const cols = this.columns;

    let html = `<div class="table-container"><div class="table-scroll"><table class="data-table"><thead><tr>`;
    if (this.selectable) html += `<th class="sticky-col" style="left:0;width:36px">☑</th>`;

    cols.forEach((col, ci) => {
      const isSticky = this._isSticky(col.key);
      const sortCls = this.sortable && col.sortable !== false ? "sortable" : "";
      const sortedCls = this.sortCol === col.key ? `sorted-${this.sortDir}` : "";
      const stickyCls = isSticky ? "sticky-col" : "";
      const stickyStyle = isSticky ? this._stickyStyle(col.key) : "";
      html += `<th class="${sortCls} ${sortedCls} ${stickyCls}" data-col="${esc(col.key)}" data-ci="${ci}"${stickyStyle ? ` style="${stickyStyle}"` : ""} draggable="true">
        <span class="col-drag">⠿</span>${esc(col.label || col.key)}
      </th>`;
    });
    if (this.rowActions.length) html += `<th>Actions</th>`;
    html += `</tr></thead><tbody>`;

    for (const row of sorted) {
      const sel = this.selected.has(row.id);
      const rowCls = [sel ? "selected" : "", this.rowClass ? this.rowClass(row) : ""].filter(Boolean).join(" ");
      html += `<tr class="${rowCls}" data-id="${row.id}">`;
      if (this.selectable) {
        html += `<td class="sticky-col" style="left:0"><input type="checkbox" ${sel ? "checked" : ""} data-check="${row.id}"></td>`;
      }
      cols.forEach((col) => {
        const isSticky = this._isSticky(col.key);
        const stickyStyle = isSticky ? this._stickyStyle(col.key) : "";
        const val = col.render ? col.render(row) : (row[col.key] ?? row.row_data?.[col.key] ?? "-");
        const cls = [isSticky ? "sticky-col" : "", col.numeric ? "num" : ""].filter(Boolean).join(" ");
        html += `<td class="${cls}"${stickyStyle ? ` style="${stickyStyle}"` : ""}>${val}</td>`;
      });
      if (this.rowActions.length) {
        html += `<td>${this.rowActions.map((a) =>
          `<button class="icon-btn" data-action="${a.id}" data-row="${row.id}" title="${esc(a.title || "")}">${a.icon || a.label}</button>`
        ).join("")}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div></div>`;
    this.container.innerHTML = html;
    this._bind();
  }

  _sortedRows() {
    if (!this.sortCol) return [...this.rows];
    const key = this.sortCol;
    const dir = this.sortDir === "asc" ? 1 : -1;
    return [...this.rows].sort((a, b) => {
      let av = a[key] ?? a.row_data?.[key] ?? "";
      let bv = b[key] ?? b.row_data?.[key] ?? "";
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  _bind() {
    this.container.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", (e) => {
        if (e.target.classList.contains("col-drag")) return;
        const col = th.dataset.col;
        if (this.sortCol === col) this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
        else { this.sortCol = col; this.sortDir = "asc"; }
        this._render();
      });
    });

    this.container.querySelectorAll("th[draggable]").forEach((th) => {
      th.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("col-index", th.dataset.ci);
      });
      th.addEventListener("dragover", (e) => e.preventDefault());
      th.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("col-index"));
        const to = Number(th.dataset.ci);
        if (from === to || isNaN(from) || isNaN(to)) return;
        const col = this.columns.splice(from, 1)[0];
        this.columns.splice(to, 0, col);
        this._render();
      });
    });

    this.container.querySelectorAll("[data-check]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = Number(cb.dataset.check);
        if (cb.checked) this.selected.add(id);
        else this.selected.delete(id);
        this.onSelectionChange([...this.selected]);
        this._render();
      });
    });

    this.container.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = this.rows.find((r) => r.id === Number(btn.dataset.row));
        if (row && this.onRowAction) this.onRowAction(btn.dataset.action, row);
      });
    });
  }
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

window.DataTable = DataTable;
