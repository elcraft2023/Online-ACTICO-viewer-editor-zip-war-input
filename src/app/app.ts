import { Component, ElementRef, ViewChild, ChangeDetectorRef, ViewEncapsulation, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import JSZip from 'jszip';

interface RuleFileEntry {
  fullPath: string;
  fileName: string;
}

interface SidebarFolder {
  folderName: string;
  files: RuleFileEntry[];
  isCollapsed: boolean;
  isVisible: boolean;
}

interface SidebarItem {
  type: 'file' | 'folder';
  file?: RuleFileEntry;
  folder?: SidebarFolder;
  isVisible: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrls: ['./app.css'],
  encapsulation: ViewEncapsulation.None
})
export class App {
  @ViewChild('visualContainer') visualContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  loadedZip: JSZip | null = null;
  originalFileName: string = 'updated_archive.zip';
  archiveTitleText: string = '📁 Kein Archiv geladen';
  activeFilePath: string | null = null;

  sidebarItems: SidebarItem[] = [];
  allRuleFiles: RuleFileEntry[] = [];
  ruleNavStack: string[] = [];
  searchQuery: string = '';

  showVisual = true;
  showCode = false;
  /** @deprecated derived */ get activeView(): 'visual' | 'code' | 'split' {
    if (this.showVisual && this.showCode) return 'split';
    if (this.showCode) return 'code';
    return 'visual';
  }
  isDragOver = false;
  currentXmlText: string = '';

  isModalOpen = false;
  panX = 0;
  panY = 0;
  zoomScale = 1;
  private canvasHovered = false;
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panOriginX = 0;
  private panOriginY = 0;
  selectedNodeEl: HTMLElement | null = null;

  selectedXmlElement: Element | null = null;
  modalTagName = '';
  modalNodeName = '';
  modalNodeExpr = '';
  modalChildTag = 'decide';
  isReadmeOpen = false;
  showPalette = false;
  contentView = true;
  showContext = false;
  contextInputs: string[] = [];
  contextOutputs: string[] = [];

  private undoStack: string[] = [];
  private redoStack: string[] = [];


  constructor(private cdRef: ChangeDetectorRef) {
    setTimeout(() => this.renderTree(), 0);
  }

  /** Undo/Redo: Ctrl/Cmd+Shift+Z/Y · Zoom: Ctrl/Cmd + +/− */
  @HostListener('document:keydown', ['$event'])
  handleHotkeys(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;

    const key = event.key;
    const keyLow = key.toLowerCase();
    const code = event.code;
    const t = event.target as HTMLElement | null;
    const typing = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable));

    // Zoom nur wenn Maus über dem Flow-Canvas ist → kein Konflikt mit Browser-Zoom
    if (!event.shiftKey && !event.altKey && !typing && this.canvasHovered) {
      const zoomIn =
        key === '+' || key === '=' ||
        code === 'Equal' || code === 'NumpadAdd';
      const zoomOut =
        key === '-' || key === '_' ||
        code === 'Minus' || code === 'NumpadSubtract';
      if (zoomIn) {
        event.preventDefault();
        this.zoomBy(0.1, this.canvasCenterPivot());
        return;
      }
      if (zoomOut) {
        event.preventDefault();
        this.zoomBy(-0.1, this.canvasCenterPivot());
        return;
      }
    }

    // Undo/Redo: Ctrl/Cmd + Shift + Z/Y
    if (event.shiftKey && !event.altKey) {
      if (keyLow === 'z') {
        event.preventDefault();
        this.undo();
        return;
      }
      if (keyLow === 'y') {
        event.preventDefault();
        this.redo();
        return;
      }
    }
  }

  /** Multiplicative zoom. Optional cursor position in canvas client coords for zoom-to-pointer. */
  zoomBy(delta: number, pivot?: { x: number; y: number }) {
    const old = this.zoomScale;
    // delta > 0 → rein, < 0 → raus; fein genug für z.B. 43 %
    const factor = delta > 0 ? 1.08 : 1 / 1.08;
    let next = old * (Math.abs(delta) >= 0.05 ? factor : Math.pow(factor, Math.abs(delta) / 0.1));
    // sehr weit raus (2 %) bis weit rein (500 %)
    next = Math.min(5, Math.max(0.02, next));
    // etwas runden für stabile Anzeige, aber feinstufig
    next = Math.round(next * 1000) / 1000;
    if (pivot) {
      // Punkt unter dem Zeiger bleibt fix
      const contentX = (pivot.x - this.panX) / old;
      const contentY = (pivot.y - this.panY) / old;
      this.panX = pivot.x - contentX * next;
      this.panY = pivot.y - contentY * next;
    }
    this.zoomScale = next;
    this.applyCanvasTransform();
  }

  private canvasCenterPivot(): { x: number; y: number } | undefined {
    const canvas = this.visualContainer?.nativeElement?.querySelector('.actico-canvas') as HTMLElement | null;
    if (!canvas) return undefined;
    const r = canvas.getBoundingClientRect();
    return { x: r.width / 2, y: r.height / 2 };
  }

  /** Update transform on existing canvas without full re-render */
  private applyCanvasTransform() {
    if (!this.visualContainer) return;
    const flowchart = this.visualContainer.nativeElement.querySelector('.actico-flow') as HTMLElement | null;
    const rb = this.visualContainer.nativeElement.querySelector('[data-action="zoom-reset"]');
    if (flowchart) {
      flowchart.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoomScale})`;
    }
    if (rb) rb.textContent = Math.round(this.zoomScale * 100) + ' %';
  }

  togglePanel(panel: 'visual' | 'code') {
    if (panel === 'visual') {
      if (this.showVisual && !this.showCode) {
        // can't turn off last panel
        return;
      }
      this.showVisual = !this.showVisual;
      if (!this.showVisual) this.showPalette = false;
    } else {
      if (this.showCode && !this.showVisual) {
        return;
      }
      this.showCode = !this.showCode;
      if (this.showCode && !this.showVisual) {
        // only XML – fine
      }
      if (!this.showVisual) this.showPalette = false;
    }
    // ensure at least one
    if (!this.showVisual && !this.showCode) {
      this.showVisual = true;
    }
    this.cdRef.detectChanges();
    if (this.showVisual) {
      setTimeout(() => this.renderTree(), 50);
    }
  }

  setView(view: 'visual' | 'code' | 'split') {
    // compat
    if (view === 'split') { this.showVisual = true; this.showCode = true; }
    else if (view === 'code') { this.showVisual = false; this.showCode = true; this.showPalette = false; }
    else { this.showVisual = true; this.showCode = false; }
    this.cdRef.detectChanges();
    if (this.showVisual) setTimeout(() => this.renderTree(), 0);
  }

  onXmlEdited() {
    if (this.showVisual) {
      setTimeout(() => this.renderTree(), 120);
    }
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
  }

  async onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    const file = files[0];
    const n = file.name.toLowerCase();
    if (!n.endsWith('.zip') && !n.endsWith('.war')) {
      alert('Bitte eine .zip oder .war Datei ablegen.');
      return;
    }
    await this.loadArchiveFile(file);
  }

  triggerFileInput() {
    if (this.fileInput) {
      this.fileInput.nativeElement.click();
    }
  }

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      await this.loadArchiveFile(input.files[0]);
      input.value = '';
    }
  }

  async loadArchiveFile(file: File) {
    this.originalFileName = file.name;
    const cleanName = file.name.replace(/\.(zip|war)$/i, '');
    this.archiveTitleText = `📁 ${cleanName}`;
    this.activeFilePath = null;
    this.currentXmlText = '';
    this.undoStack = [];
    this.redoStack = [];
    this.ruleNavStack = [];
    this.allRuleFiles = [];
    try {
      this.loadedZip = await JSZip.loadAsync(file);
      this.parseZipEntries();
      this.cdRef.detectChanges();
    } catch (err: any) {
      console.error('Error loading ZIP:', err);
      alert('Fehler beim Öffnen des Archivs: ' + (err?.message || err));
    }
  }

  private parseZipEntries() {
    if (!this.loadedZip) return;
    const ruleFiles: RuleFileEntry[] = [];
    // filled below

    this.loadedZip.forEach((relativePath, zipEntry) => {
      if (!zipEntry.dir && /\.(vrrule|vcrule|vrtable|vrdtable|xml)$/i.test(relativePath)) {
        const parts = relativePath.split('/');
        const fileName = parts.pop() || relativePath;
        ruleFiles.push({ fullPath: relativePath, fileName });
      }
    });

    this.allRuleFiles = ruleFiles.slice();

    const folderGroups: { [key: string]: RuleFileEntry[] } = {};

    ruleFiles.forEach(fileObj => {
      const parts = fileObj.fullPath.split('/');
      parts.pop();
      const folderPath = parts.join('/') || 'Root';

      if (!folderGroups[folderPath]) {
        folderGroups[folderPath] = [];
      }
      folderGroups[folderPath].push(fileObj);
    });

    const items: SidebarItem[] = [];

    Object.keys(folderGroups).forEach(folder => {
      const files = folderGroups[folder];

      if (files.length > 1 && folder !== 'Root') {
        items.push({
          type: 'folder',
          folder: {
            folderName: folder,
            files: files,
            isCollapsed: true,
            isVisible: true
          },
          isVisible: true
        });
      } else {
        files.forEach(fileObj => {
          items.push({
            type: 'file',
            file: fileObj,
            isVisible: true
          });
        });
      }
    });

    this.sidebarItems = items;
    this.filterRules();
    this.cdRef.detectChanges();
  }

  filterRules() {
    const query = this.searchQuery.toLowerCase().trim();

    this.sidebarItems.forEach(item => {
      if (item.type === 'file' && item.file) {
        item.isVisible = item.file.fileName.toLowerCase().includes(query) || item.file.fullPath.toLowerCase().includes(query);
      } else if (item.type === 'folder' && item.folder) {
        if (!query) {
          item.isVisible = true;
          item.folder.isVisible = true;
          item.folder.isCollapsed = true;
        } else {
          const hasMatchingFiles = item.folder.files.some(f =>
            f.fileName.toLowerCase().includes(query) || f.fullPath.toLowerCase().includes(query)
          );
          item.isVisible = hasMatchingFiles;
          item.folder.isVisible = hasMatchingFiles;
          if (hasMatchingFiles) {
            item.folder.isCollapsed = false;
          }
        }
      }
    });
  }

  toggleFolder(folderItem: SidebarFolder) {
    folderItem.isCollapsed = !folderItem.isCollapsed;
  }

  toggleAllFolders() {
    const folderItems = this.sidebarItems
      .filter(i => i.type === 'folder' && i.folder)
      .map(i => i.folder!);

    if (folderItems.length === 0) return;

    const hasExpanded = folderItems.some(f => !f.isCollapsed);
    folderItems.forEach(f => {
      f.isCollapsed = hasExpanded;
    });
  }

  /** Find .vrrule path by rule display name or file name */
  findRulePath(ruleName: string): string | null {
    if (!ruleName || !this.allRuleFiles.length) return null;
    const norm = (s: string) =>
      s.trim().toLowerCase().replace(/\.(vrrule|vcrule|vrtable|vrdtable|xml)$/i, '').replace(/[_\s]+/g, ' ').trim();
    const target = norm(ruleName);
    if (!target) return null;

    // 1) exact base name
    let hit = this.allRuleFiles.find(f => norm(f.fileName) === target);
    if (hit) return hit.fullPath;

    // 2) path segment equals target
    hit = this.allRuleFiles.find(f => {
      const parts = f.fullPath.split('/').map(norm);
      return parts.includes(target);
    });
    if (hit) return hit.fullPath;

    // 3) includes either way
    hit = this.allRuleFiles.find(f => {
      const b = norm(f.fileName);
      return b.includes(target) || target.includes(b);
    });
    if (hit) return hit.fullPath;

    // 4) full path contains target
    hit = this.allRuleFiles.find(f => norm(f.fullPath).includes(target));
    return hit ? hit.fullPath : null;
  }

  async navigateToLinkedRule(ruleName: string) {
    if (!ruleName || !ruleName.trim()) {
      alert('Diese Verknüpfung hat keinen Regelnamen.');
      return;
    }
    if (!this.loadedZip || !this.allRuleFiles.length) {
      alert('Kein Archiv geladen. Bitte zuerst eine ZIP/WAR mit den Regeln laden.');
      return;
    }
    const path = this.findRulePath(ruleName);
    if (!path) {
      alert(
        `Verknüpfte Regel „${ruleName}“ ist im geladenen Archiv nicht enthalten.\n\n` +
        `Mögliche Ursachen:\n` +
        `• Die Regel liegt in einer anderen ZIP\n` +
        `• Anderer Dateiname als der Call-Name\n` +
        `• Datei fehlt im Archiv`
      );
      return;
    }
    // aktuelle Änderungen im ZIP behalten
    if (this.loadedZip && this.activeFilePath && this.currentXmlText) {
      this.loadedZip.file(this.activeFilePath, this.currentXmlText);
    }
    if (this.activeFilePath) {
      this.ruleNavStack.push(this.activeFilePath);
    }
    this.panX = 0;
    this.panY = 0;
    this.zoomScale = 1;
    await this.selectRule(path);
    this.cdRef.detectChanges();
  }

  async navigateBack() {
    if (!this.ruleNavStack.length) {
      alert('Noch keine Ausgangsdatei gespeichert.\n\nZuerst einen Call-Knoten (↗) anklicken, dann kannst du mit „← Datei“ wieder zur Ausgangsdatei springen.');
      return;
    }
    // aktuelle Datei im ZIP merken, dann vorherige wie neu öffnen
    if (this.loadedZip && this.activeFilePath && this.currentXmlText) {
      this.loadedZip.file(this.activeFilePath, this.currentXmlText);
    }
    const prev = this.ruleNavStack.pop()!;
    // wie frisch aus der Sidebar geöffnet
    this.panX = 0;
    this.panY = 0;
    this.zoomScale = 1;
    this.selectedXmlElement = null;
    this.selectedNodeEl = null;
    this.isModalOpen = false;
    this.showPalette = false;
    this.undoStack = [];
    this.redoStack = [];
    await this.selectRule(prev);
    this.cdRef.detectChanges();
  }

  canNavigateBack(): boolean {
    return this.ruleNavStack.length > 0;
  }

  /** Ordner in der Sidebar aufklappen, der die Datei enthält */
  private expandFolderForPath(filePath: string) {
    const parts = filePath.split('/');
    parts.pop();
    const folderPath = parts.join('/') || 'Root';

    this.sidebarItems.forEach(item => {
      if (item.type !== 'folder' || !item.folder) return;
      const name = item.folder.folderName;
      // exakter Ordner oder Parent-Pfad-Match
      const matches =
        name === folderPath ||
        folderPath === name ||
        folderPath.startsWith(name + '/') ||
        name.startsWith(folderPath + '/') ||
        item.folder.files.some(f => f.fullPath === filePath);
      if (matches) {
        item.folder.isCollapsed = false;
        item.folder.isVisible = true;
        item.isVisible = true;
      }
    });
  }

  async selectRule(filePath: string) {
    if (!this.loadedZip) return;
    this.activeFilePath = filePath;
    // immer wie neu geöffnet
    this.undoStack = [];
    this.redoStack = [];
    this.showPalette = false;
    this.selectedXmlElement = null;
    this.selectedNodeEl = null;
    this.isModalOpen = false;
    this.panX = 0;
    this.panY = 0;
    this.zoomScale = 1;
    this.expandFolderForPath(filePath);
    const file = this.loadedZip.file(filePath);
    if (file) {
      this.currentXmlText = await file.async('string');
      this.cdRef.detectChanges();
      setTimeout(() => {
        this.renderTree();
        this.scrollSidebarToActive(filePath);
      }, 50);
    } else {
      this.cdRef.detectChanges();
    }
  }

  /** Aktive Datei in der Sidebar in den sichtbaren Bereich scrollen */
  private scrollSidebarToActive(filePath: string) {
    try {
      const list = document.getElementById('file-list');
      if (!list) return;
      const active = list.querySelector('.rule-btn.active') as HTMLElement | null;
      if (active) {
        active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    } catch { /* ignore */ }
  }

  // ═══════════════════════════════════════════
  // ACTICO Visual Rules (.vrrule) parser
  // Flow is nested via <successors xsi:type="...">
  // ═══════════════════════════════════════════

  private getXsiType(el: Element): string {
    return (
      el.getAttribute('xsi:type') ||
      el.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type') ||
      ''
    );
  }

  private typeKind(xsiType: string): string {
    const t = xsiType.toLowerCase();
    if (t.includes('expressiondecision') || t.endsWith(':decision')) return 'decide';
    if (t.includes('expressioncaseblock') || t.includes('caseblock')) return 'case';
    if (t.includes('expressionelseblock') || t.includes('elseblock')) return 'else';
    if (t.includes('manipulations') || t.includes('assignment') || t.includes('substitute')) return 'assign';
    if (t.includes('actioncall')) return 'action';
    if (t.includes('flowrulecall') || t.includes('decisiontablerulecall') || t.includes('rulecall')) return 'call';
    if (t.includes('scorecard')) return 'scorecard';
    if (t.includes('return') || t.includes('exception')) return 'end';
    return '';
  }

  private infoText(el: Element): string {
    for (const c of Array.from(el.children)) {
      const tag = c.nodeName.toLowerCase();
      if (tag.includes('information') || tag.endsWith('informations')) {
        const tx = c.getAttribute('text');
        if (tx) return tx.trim();
      }
    }
    return (el.getAttribute('name') || el.getAttribute('actionName') || el.getAttribute('ruleName') || '').trim();
  }

  private exprText(el: Element): string {
    const parts: string[] = [];
    for (const c of Array.from(el.children)) {
      const tag = c.nodeName.toLowerCase();
      if (tag.includes('expression') && !tag.includes('decision') && !tag.includes('case') && !tag.includes('else')) {
        const tx = c.getAttribute('text');
        if (tx) parts.push(tx.trim());
      }
      // nested assignments under Manipulations
      if (tag.includes('manipulation') || this.typeKind(this.getXsiType(c)) === 'assign') {
        const sub = this.exprText(c);
        if (sub) parts.push(sub);
        const it = this.infoText(c);
        // target of assignment often in attributes or child
      }
    }
    // also check assignment target attributes
    const target = el.getAttribute('target') || el.getAttribute('variable');
    if (target && parts.length) return target + ' := ' + parts.join('; ');
    return parts.join('; ');
  }

  private successorChildren(el: Element): Element[] {
    return Array.from(el.children).filter(c => {
      const tag = c.nodeName.toLowerCase();
      return tag === 'successors' || tag.endsWith(':successors') || tag.includes('successor');
    });
  }

  /** Top-level flow steps of a FlowRule (direct successors of root) */
  private rootFlowSteps(root: Element): Element[] {
    // Prefer direct successors of the rule root
    let steps = this.successorChildren(root);
    if (steps.length) return steps;
    // Sometimes wrapped one level deep
    for (const c of Array.from(root.children)) {
      const inner = this.successorChildren(c);
      if (inner.length) return inner;
    }
    // Fallback: any element with a known flow xsi:type under root
    return Array.from(root.children).filter(c => this.typeKind(this.getXsiType(c)) !== '');
  }

  renderTree() {
    if (!this.visualContainer) return;
    const container = this.visualContainer.nativeElement;
    container.innerHTML = '';

    if (!this.currentXmlText) {
      container.innerHTML = `
        <div class="actico-empty">
          <div class="actico-empty-icon">◇</div>
          <p>Wähle links eine .vrrule Datei aus.</p>
        </div>`;
      return;
    }

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(this.currentXmlText, 'text/xml');
    if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
      container.innerHTML = '<p class="actico-error">⚠️ Ungültiges XML</p>';
      return;
    }

    const root = xmlDoc.documentElement;
    const ruleName = root.getAttribute('name') || 'Flow Rule';

    const toolbar = document.createElement('div');
    toolbar.className = 'actico-toolbar';
    toolbar.innerHTML = `
      <span class="actico-toolbar-title">ACTICO Flow — ${this.escapeHtml(ruleName)}</span>
      <div class="actico-toolbar-actions">
        <button type="button" class="actico-tb-btn" data-action="zoom-out">−</button>
        <button type="button" class="actico-tb-btn" data-action="zoom-reset">100 %</button>
        <button type="button" class="actico-tb-btn" data-action="zoom-in">+</button>
      </div>`;
    container.appendChild(toolbar);

    const canvas = document.createElement('div');
    canvas.className = 'actico-canvas' + (this.contentView ? ' content-on' : ' content-off');
    canvas.addEventListener('mouseenter', () => { this.canvasHovered = true; });
    canvas.addEventListener('mouseleave', () => { this.canvasHovered = false; });
    // Mausrad = Zoom zur Zeigerposition (smooth, fein)
    canvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const pivot = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // deltaY: positiv = runter = rauszoomen
      const steps = Math.max(1, Math.min(5, Math.abs(e.deltaY) / 40));
      for (let i = 0; i < steps; i++) {
        this.zoomBy(e.deltaY < 0 ? 0.1 : -0.1, pivot);
      }
    }, { passive: false });
    const flowchart = document.createElement('div');
    flowchart.className = 'actico-flow';
    flowchart.style.transformOrigin = 'top left';

    // Start
    const startEl = document.createElement('div');
    startEl.className = 'node-start';
    startEl.title = 'Start';
    flowchart.appendChild(startEl);

    const steps = this.rootFlowSteps(root);
    steps.forEach(step => {
      flowchart.appendChild(this.makeVLine());
      flowchart.appendChild(this.buildActicoNode(step));
    });

    if (!steps.length) {
      const hint = document.createElement('div');
      hint.style.padding = '20px';
      hint.style.color = '#64748b';
      hint.textContent = 'Keine Flow-Schritte (successors) gefunden.';
      flowchart.appendChild(hint);
    }

    // Apply existing pan
    flowchart.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoomScale})`;

    canvas.appendChild(flowchart);
    container.appendChild(canvas);
    if (this.showContext) this.refreshContextData();

    const applyTransform = () => {
      flowchart.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoomScale})`;
      const rb = toolbar.querySelector('[data-action="zoom-reset"]');
      if (rb) rb.textContent = Math.round(this.zoomScale * 100) + ' %';
    };
    applyTransform();
    toolbar.querySelectorAll('.actico-tb-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = (btn as HTMLElement).dataset['action'];
        if (action === 'zoom-in') {
          this.zoomScale = Math.min(5, Math.round(this.zoomScale * 1.08 * 1000) / 1000);
        } else if (action === 'zoom-out') {
          this.zoomScale = Math.max(0.02, Math.round(this.zoomScale / 1.08 * 1000) / 1000);
        } else if (action === 'zoom-reset') {
          this.zoomScale = 1;
          this.panX = 0;
          this.panY = 0;
        }
        applyTransform();
      });
    });

    // Pan: nur leere Fläche, Pointer-Capture (kein hängender Grab-Cursor, keine Textauswahl)
    const isNodeTarget = (t: EventTarget | null) => {
      if (!(t instanceof Element)) return false;
      return !!t.closest(
        '.node-assign, .node-decide-wrap, .node-action, .node-call, .node-scorecard, .node-generic, .diamond, .decide-label, .branch-badge, .node-start, .actico-toolbar, .actico-tb-btn'
      );
    };

    const endPan = () => {
      if (!this.isPanning) return;
      this.isPanning = false;
      canvas.classList.remove('panning');
      document.body.classList.remove('actico-panning-active');
    };

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (isNodeTarget(e.target)) return;
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.panOriginX = this.panX;
      this.panOriginY = this.panY;
      canvas.classList.add('panning');
      document.body.classList.add('actico-panning-active');
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.isPanning) return;
      this.panX = this.panOriginX + (e.clientX - this.panStartX);
      this.panY = this.panOriginY + (e.clientY - this.panStartY);
      applyTransform();
    });

    canvas.addEventListener('pointerup', (e: PointerEvent) => {
      endPan();
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    canvas.addEventListener('pointercancel', () => endPan());
    canvas.addEventListener('lostpointercapture', () => endPan());
  }

  private makeVLine(): HTMLElement {
    const v = document.createElement('div');
    v.className = 'v-line';
    return v;
  }

  private buildActicoNode(el: Element): HTMLElement {
    const kind = this.typeKind(this.getXsiType(el));
    const label = this.infoText(el);
    const expr = this.exprText(el);

    if (kind === 'decide') return this.buildDecideFromSuccessors(el, label, expr);
    if (kind === 'assign') return this.buildAssignNode(el, label || 'Assign', expr);
    if (kind === 'action') {
      const an = el.getAttribute('actionName') || label || 'Action';
      return this.buildActionNode(el, an, expr);
    }
    if (kind === 'call') {
      const rn = el.getAttribute('ruleName') || label || 'Call Rule';
      return this.buildCallNode(el, rn, this.getXsiType(el));
    }
    if (kind === 'scorecard') return this.buildScorecardNode(el, label, expr);
    if (kind === 'end') return this.buildEndNode(el, label, expr);

    // Case/Else alone shouldn't appear as top node often – render as generic sequence
    if (kind === 'case' || kind === 'else') {
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.alignItems = 'flex-start';
      this.successorChildren(el).forEach((s, i) => {
        if (i > 0) wrap.appendChild(this.makeVLine());
        wrap.appendChild(this.buildActicoNode(s));
      });
      return wrap;
    }

    // Unknown with nested successors → chain them
    const nested = this.successorChildren(el);
    if (nested.length) {
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.alignItems = 'flex-start';
      nested.forEach((s, i) => {
        if (i > 0) wrap.appendChild(this.makeVLine());
        wrap.appendChild(this.buildActicoNode(s));
      });
      return wrap;
    }

    // Fallback: show label if any
    return this.buildGenericNode(el, label || el.nodeName, expr, el.nodeName);
  }

  private buildDecideFromSuccessors(el: Element, name: string, expr: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'node-decide-wrap';

    const row = document.createElement('div');
    row.className = 'decide-row';

    const diamond = document.createElement('div');
    diamond.className = 'diamond';
    diamond.innerHTML = '<div class="diamond-inner"></div>';
    diamond.addEventListener('click', e => {
      e.stopPropagation();
      this.openEditModal(el, 'Decide', name, expr);
    });
    row.appendChild(diamond);

    const labelEl = document.createElement('div');
    labelEl.className = 'decide-label';
    labelEl.innerHTML = `<div class="d-title">${this.escapeHtml(name || 'Decide')}</div>` +
      (this.contentView && expr ? `<div class="d-expr">${this.escapeHtml(expr)}</div>` : '');
    labelEl.addEventListener('click', e => {
      e.stopPropagation();
      this.openEditModal(el, 'Decide', name, expr);
    });
    row.appendChild(labelEl);
    wrap.appendChild(row);

    // Children: ExpressionCaseBlock / ExpressionElseBlock
    const cases = this.successorChildren(el);
    if (cases.length) {
      const vUnder = document.createElement('div');
      vUnder.className = 'v-line';
      vUnder.style.height = '10px';
      wrap.appendChild(vUnder);

      const branchesCol = document.createElement('div');
      branchesCol.className = 'branches';

      cases.forEach((caseEl, idx) => {
        const ck = this.typeKind(this.getXsiType(caseEl));
        const cond =
          this.infoText(caseEl) ||
          (ck === 'else' ? 'else' : (ck === 'case' ? 'case' : 'Pfad ' + (idx + 1)));

        const branch = document.createElement('div');
        branch.className = 'branch';

        const badge = document.createElement('div');
        badge.className = 'branch-badge';
        // Content View off → short label only
        badge.textContent = this.contentView
          ? cond
          : (cond.length > 18 ? cond.slice(0, 16) + '…' : cond);
        if (!this.contentView) badge.classList.add('compact');
        badge.addEventListener('click', e => {
          e.stopPropagation();
          this.openEditModal(caseEl, ck || 'Case', cond, this.exprText(caseEl));
        });
        branch.appendChild(badge);

        const h = document.createElement('div');
        h.className = 'branch-h';
        branch.appendChild(h);

        // sequential successors inside the case – horizontal like ACTICO
        const inner = this.successorChildren(caseEl);
        if (inner.length) {
          const row = document.createElement('div');
          row.className = 'branch-content';
          inner.forEach((s, si) => {
            if (si > 0) {
              const h = document.createElement('div');
              h.className = 'h-seq';
              row.appendChild(h);
            }
            row.appendChild(this.buildActicoNode(s));
          });
          branch.appendChild(row);
        }

        branchesCol.appendChild(branch);
      });
      wrap.appendChild(branchesCol);
    }
    return wrap;
  }

  private buildAssignNode(el: Element, name: string, expr: string): HTMLElement {
    // Prefer expression from nested SubstituteAssignment
    let displayExpr = expr;
    if (!displayExpr) {
      for (const c of Array.from(el.children)) {
        if (this.typeKind(this.getXsiType(c)) === 'assign' || c.nodeName.toLowerCase().includes('manipulation')) {
          displayExpr = this.exprText(c) || this.infoText(c);
          if (displayExpr) break;
        }
      }
    }
    const node = document.createElement('div');
    node.className = 'node-assign';
    node.innerHTML = `
      <div class="icon-block">
        <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" fill="#90caf9" rx="1"/><rect x="3" y="3" width="6" height="6" fill="#e3f2fd" rx="0.5"/></svg>
      </div>
      <div class="body">
        <div class="title">${this.escapeHtml(name || 'Assign')}</div>
        ${this.contentView && displayExpr ? '<div class="expr">' + this.escapeHtml(displayExpr) + '</div>' : ''}
      </div>`;
    node.addEventListener('click', e => {
      e.stopPropagation();
      this.openEditModal(el, 'Assign', name, displayExpr);
    });

    // chain further successors after this assign
    const next = this.successorChildren(el);
    if (!next.length) return node;

    // horizontal chain: Assign → Action/Call (ACTICO style)
    const wrap = document.createElement('div');
    wrap.className = 'branch-content';
    wrap.appendChild(node);
    next.forEach(s => {
      const h = document.createElement('div');
      h.className = 'h-seq';
      wrap.appendChild(h);
      wrap.appendChild(this.buildActicoNode(s));
    });
    return wrap;
  }

  private buildActionNode(el: Element, name: string, expr: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'node-action';
    node.innerHTML = `
      <div class="action-circle">▶</div>
      <div class="body">
        <div class="title">${this.escapeHtml(name || 'Action')}</div>
        ${this.contentView && expr ? '<div class="expr">' + this.escapeHtml(expr) + '</div>' : ''}
      </div>`;
    node.addEventListener('click', e => {
      e.stopPropagation();
      this.openEditModal(el, 'Action', name, expr);
    });
    const next = this.successorChildren(el);
    if (!next.length) return node;
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'flex-start';
    wrap.appendChild(node);
    next.forEach(s => {
      wrap.appendChild(this.makeVLine());
      wrap.appendChild(this.buildActicoNode(s));
    });
    return wrap;
  }

  private buildCallNode(el: Element, name: string, xsiType: string): HTMLElement {
    const isTable = xsiType.toLowerCase().includes('decisiontable');
    const linked = this.findRulePath(name);
    const node = document.createElement('div');
    node.className = 'node-call node-call-linked';
    node.title = linked
      ? `Klick: zu „${name}“ springen · Shift+Klick: bearbeiten`
      : `Klick: Verknüpfung öffnen (nicht im Archiv → Fehlermeldung) · Shift+Klick: bearbeiten`;
    node.innerHTML = `
      <div class="icon-block">${isTable ? '▦' : '▣'}</div>
      <div class="body">
        <div class="title">${this.escapeHtml(name)} <span class="link-arrow">↗</span></div>
        ${this.contentView ? '<div class="expr">' + (isTable ? 'Call Decision Table' : 'Call Flow Rule') + (linked ? ' · im Archiv' : ' · fehlt im Archiv') + '</div>' : ''}
      </div>`;
    node.addEventListener('click', e => {
      e.stopPropagation();
      const me = e as MouseEvent;
      // Shift/Alt+Klick → nur bearbeiten
      if (me.shiftKey || me.altKey) {
        this.openEditModal(el, isTable ? 'DecisionTable' : 'FlowRuleCall', name, '');
        return;
      }
      // Immer navigieren versuchen (Fehlerdialog wenn Ziel fehlt)
      this.navigateToLinkedRule(name);
    });
    const next = this.successorChildren(el);
    if (!next.length) return node;
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'flex-start';
    wrap.appendChild(node);
    next.forEach(s => {
      wrap.appendChild(this.makeVLine());
      wrap.appendChild(this.buildActicoNode(s));
    });
    return wrap;
  }

  private buildScorecardNode(el: Element, name: string, expr: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'node-scorecard';
    node.innerHTML = `<div class="icon-block">▦</div><div class="body"><div class="title">${this.escapeHtml(name || 'Scorecard')}</div>
      ${expr ? '<div class="expr">' + this.escapeHtml(expr) + '</div>' : ''}</div>`;
    node.addEventListener('click', e => {
      e.stopPropagation();
      this.openEditModal(el, 'Scorecard', name, expr);
    });
    return node;
  }

  private buildEndNode(el: Element, name: string, expr: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'node-generic node-end';
    node.innerHTML = `
      <div class="end-flag"></div>
      <div class="generic-box"><div class="title">${this.escapeHtml(name || 'Done & Return')}</div></div>`;
    node.addEventListener('click', e => {
      e.stopPropagation();
      this.openEditModal(el, 'End', name, expr);
    });
    return node;
  }

  private buildGenericNode(el: Element, name: string, expr: string, tag: string): HTMLElement {
    const node = document.createElement('div');
    node.className = 'node-generic';
    node.innerHTML = `
      <div class="generic-box">
        <div class="title">${this.escapeHtml(name || tag)}</div>
        ${expr ? '<div class="expr">' + this.escapeHtml(expr) + '</div>' : ''}
      </div>`;
    node.addEventListener('click', e => {
      e.stopPropagation();
      this.openEditModal(el, tag, name, expr);
    });
    return node;
  }

  expandAllNodes() {
    if (!this.visualContainer) return;
    const containers = this.visualContainer.nativeElement.querySelectorAll('.node-children');
    containers.forEach(c => c.classList.remove('collapsed'));
    const toggles = this.visualContainer.nativeElement.querySelectorAll('.collapse-toggle');
    toggles.forEach(t => {
      if (t.textContent !== '•') t.textContent = '▼';
    });
  }

  collapseAllNodes() {
    if (!this.visualContainer) return;
    const containers = this.visualContainer.nativeElement.querySelectorAll('.node-children');
    containers.forEach(c => c.classList.add('collapsed'));
    const toggles = this.visualContainer.nativeElement.querySelectorAll('.collapse-toggle');
    toggles.forEach(t => {
      if (t.textContent !== '•') t.textContent = '▶';
    });
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  openEditModal(element: Element, tagName: string, name: string, expr: string, htmlEl?: HTMLElement) {
    this.selectedXmlElement = element;
    this.modalTagName = tagName;
    this.modalNodeName = name;
    this.modalNodeExpr = expr;
    this.isModalOpen = true;
    // highlight
    if (this.selectedNodeEl) this.selectedNodeEl.classList.remove('node-selected');
    if (htmlEl) {
      htmlEl.classList.add('node-selected');
      this.selectedNodeEl = htmlEl;
    }
    this.cdRef.detectChanges();
  }

  closeEditModal() {
    this.isModalOpen = false;
    this.cdRef.detectChanges();
  }

  saveModalChanges() {
    if (!this.selectedXmlElement) return;
    this.pushUndo();
    const el = this.selectedXmlElement;

    if (this.modalNodeName) {
      el.setAttribute('name', this.modalNodeName);
      // ACTICO: also update first <informations text="...">
      for (const c of Array.from(el.children)) {
        if (c.nodeName.toLowerCase().includes('information')) {
          c.setAttribute('text', this.modalNodeName);
          break;
        }
      }
    }

    if (this.modalNodeExpr) {
      el.setAttribute('expression', this.modalNodeExpr);
      // update first expression text attr if present
      for (const c of Array.from(el.children)) {
        if (c.nodeName.toLowerCase().includes('expression') && !c.nodeName.toLowerCase().includes('decision')) {
          c.setAttribute('text', this.modalNodeExpr);
          break;
        }
      }
    }

    this.syncDocToText();
    this.closeEditModal();
  }

  addChildNode() {
    // from modal dropdown – map to flow kinds
    const map: Record<string, string> = {
      'decide': 'decide',
      'assign': 'assign',
      'action': 'action',
      'call': 'call',
      'branch': 'decide',
    };
    const kind = map[this.modalChildTag] || 'assign';
    this.addFlowNode(kind, this.selectedXmlElement);
    this.closeEditModal();
  }

  toggleContentView() {
    this.contentView = !this.contentView;
    this.cdRef.detectChanges();
    // Force full re-render so expressions appear/disappear
    if (this.showVisual && this.visualContainer) {
      setTimeout(() => {
        this.renderTree();
        this.cdRef.detectChanges();
      }, 30);
    }
  }

  toggleContext() {
    this.showContext = !this.showContext;
    if (this.showContext) this.refreshContextData();
    this.cdRef.detectChanges();
  }

  private refreshContextData() {
    this.contextInputs = [];
    this.contextOutputs = [];
    if (!this.currentXmlText) return;
    const texts: string[] = [];
    try {
      const doc = new DOMParser().parseFromString(this.currentXmlText, 'text/xml');
      const walk = (el: Element) => {
        for (const c of Array.from(el.children)) {
          const tag = c.nodeName.toLowerCase();
          if (tag.includes('expression') && c.getAttribute('text')) {
            texts.push(c.getAttribute('text')!);
          }
          if (tag.includes('information') && c.getAttribute('text')) {
            // skip pure labels
          }
          walk(c);
        }
      };
      walk(doc.documentElement);
    } catch { /* ignore */ }

    const vars = new Set<string>();
    const assigns = new Set<string>();
    for (const t of texts) {
      // simple patterns: a := b, a = b, identifiers
      const m = t.match(/([A-Za-z_][\w.]*)\s*:=/);
      if (m) assigns.add(m[1]);
      for (const id of t.match(/[A-Za-z_][\w.]*/g) || []) {
        if (id.length > 1 && !['true','false','null','and','or','not'].includes(id.toLowerCase())) {
          vars.add(id);
        }
      }
    }
    this.contextOutputs = Array.from(assigns).sort();
    this.contextInputs = Array.from(vars).filter(v => !assigns.has(v)).sort().slice(0, 40);
  }

  addBranchToSelected() {
    if (!this.selectedXmlElement) {
      alert('Bitte zuerst eine Decide-Raute anklicken.');
      return;
    }
    const kind = this.typeKind(this.getXsiType(this.selectedXmlElement));
    if (kind !== 'decide') {
      alert('Branch kann nur an eine Decide angehängt werden. Bitte Decide anklicken.');
      return;
    }
    this.pushUndo();
    const parser = new DOMParser();
    const doc = parser.parseFromString(this.currentXmlText, 'text/xml');
    const xid = this.selectedXmlElement.getAttribute('xmi:id');
    let live: Element | null = null;
    if (xid) {
      const all = doc.getElementsByTagName('*');
      for (let i = 0; i < all.length; i++) {
        if (all[i].getAttribute('xmi:id') === xid) { live = all[i]; break; }
      }
    }
    if (!live) live = doc.documentElement;
    const caseEl = doc.createElement('successors');
    caseEl.setAttribute('xsi:type', 'de.visualrules.base.flow:ExpressionCaseBlock');
    caseEl.setAttribute('id', String(Date.now() % 100000));
    const info = doc.createElement('informations');
    info.setAttribute('text', 'new case');
    info.setAttribute('xsi:type', 'de.visualrules.base:Description');
    caseEl.appendChild(info);
    live.appendChild(caseEl);
    this.currentXmlText = new XMLSerializer().serializeToString(doc);
    this.renderTree();
    this.cdRef.detectChanges();
  }

  togglePalette() {
    this.showPalette = !this.showPalette;
    this.cdRef.detectChanges();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  private pushUndo() {
    if (this.currentXmlText) {
      this.undoStack.push(this.currentXmlText);
      if (this.undoStack.length > 50) this.undoStack.shift();
      this.redoStack = [];
    }
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.currentXmlText);
    this.currentXmlText = this.undoStack.pop()!;
    this.selectedXmlElement = null;
    this.isModalOpen = false;
    this.renderTree();
    this.cdRef.detectChanges();
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.currentXmlText);
    this.currentXmlText = this.redoStack.pop()!;
    this.selectedXmlElement = null;
    this.isModalOpen = false;
    this.renderTree();
    this.cdRef.detectChanges();
  }

    /** Append a new ACTICO flow node (as <successors xsi:type=...>) */
  addFlowNode(kind: string, parent?: Element | null) {
    if (!this.currentXmlText) {
      alert('Bitte zuerst eine Regel laden.');
      return;
    }
    this.pushUndo();
    const parser = new DOMParser();
    const doc = parser.parseFromString(this.currentXmlText, 'text/xml');
    const root = doc.documentElement;

    const typeMap: Record<string, string> = {
      decide: 'de.visualrules.base.flow:ExpressionDecision',
      assign: 'de.visualrules.base.flow:Manipulations',
      action: 'de.visualrules.base.flow:ActionCall',
      call: 'de.visualrules.base.flow:FlowRuleCall',
      table: 'de.visualrules.base.flow:DecisionTableRuleCall',
    };
    const labels: Record<string, string> = {
      decide: 'New Decision',
      assign: 'New Assign',
      action: 'New Action',
      call: 'New Flow Rule',
      table: 'New Decision Table',
    };
    const xsi = typeMap[kind] || typeMap['assign'];
    const label = labels[kind] || 'New Node';

    const succ = doc.createElement('successors');
    succ.setAttribute('xsi:type', xsi);
    succ.setAttribute('id', String(Date.now() % 100000));
    if (kind === 'action') succ.setAttribute('actionName', label);
    if (kind === 'call' || kind === 'table') succ.setAttribute('ruleName', label);

    const info = doc.createElement('informations');
    info.setAttribute('text', label);
    info.setAttribute('xsi:type', 'de.visualrules.base:Description');
    succ.appendChild(info);

    if (kind === 'decide') {
      // add one empty case so it looks like a real decide
      const caseEl = doc.createElement('successors');
      caseEl.setAttribute('xsi:type', 'de.visualrules.base.flow:ExpressionCaseBlock');
      const caseInfo = doc.createElement('informations');
      caseInfo.setAttribute('text', 'case');
      caseInfo.setAttribute('xsi:type', 'de.visualrules.base:Description');
      caseEl.appendChild(caseInfo);
      succ.appendChild(caseEl);
    }

    // Attach: under selected node if any, else under root
    const target = parent || this.selectedXmlElement;
    if (target) {
      // find the element in the new doc by xmi:id if possible
      const xid = target.getAttribute('xmi:id');
      let live: Element | null = null;
      if (xid) {
        const all = doc.getElementsByTagName('*');
        for (let i = 0; i < all.length; i++) {
          if (all[i].getAttribute('xmi:id') === xid) { live = all[i]; break; }
        }
      }
      (live || root).appendChild(succ);
    } else {
      root.appendChild(succ);
    }

    this.currentXmlText = new XMLSerializer().serializeToString(doc);
    this.renderTree();
  }

  deleteNode() {
    if (!this.selectedXmlElement || !this.selectedXmlElement.parentElement) {
      alert('Das Root-Element kann nicht gelöscht werden.');
      return;
    }
    if (confirm(`Möchtest du den Knoten <${this.selectedXmlElement.nodeName}> wirklich löschen?`)) {
      this.pushUndo();
      this.selectedXmlElement.parentElement.removeChild(this.selectedXmlElement);
      this.syncDocToText();
      this.closeEditModal();
    }
  }

  private syncDocToText() {
    if (!this.selectedXmlElement) return;
    const serializer = new XMLSerializer();
    this.currentXmlText = serializer.serializeToString(this.selectedXmlElement.ownerDocument);
    this.renderTree();
  }

  saveCurrentRuleToZip() {
    if (!this.loadedZip || !this.activeFilePath) return;
    this.loadedZip.file(this.activeFilePath, this.currentXmlText);
    alert(`Änderungen für ${this.activeFilePath} gespeichert!`);
  }

  async downloadZip() {
    if (!this.loadedZip) return;
    const content = await this.loadedZip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `updated_${this.originalFileName}`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
}
