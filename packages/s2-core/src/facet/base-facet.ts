import {
  FederatedWheelEvent,
  Group,
  Rect,
  type FederatedPointerEvent as GraphEvent,
} from '@antv/g';
import { interpolateArray } from 'd3-interpolate';
import { timer, type Timer } from 'd3-timer';
import {
  clamp,
  debounce,
  each,
  find,
  get,
  isEmpty,
  isFunction,
  isUndefined,
  last,
  reduce,
  sumBy,
} from 'lodash';
import { DataCell } from '../cell';
import {
  BACK_GROUND_GROUP_CONTAINER_Z_INDEX,
  FRONT_GROUND_GROUP_CONTAINER_Z_INDEX,
  InterceptType,
  KEY_GROUP_BACK_GROUND,
  KEY_GROUP_COL_RESIZE_AREA,
  KEY_GROUP_CORNER_RESIZE_AREA,
  KEY_GROUP_FORE_GROUND,
  KEY_GROUP_PANEL_GROUND,
  KEY_GROUP_PANEL_SCROLL,
  KEY_GROUP_ROW_INDEX_RESIZE_AREA,
  KEY_GROUP_ROW_RESIZE_AREA,
  PANEL_GROUP_GROUP_CONTAINER_Z_INDEX,
  PANEL_GROUP_SCROLL_GROUP_Z_INDEX,
  S2Event,
  ScrollbarPositionType,
} from '../common/constant';
import { DEFAULT_PAGE_INDEX } from '../common/constant/pagination';
import {
  DebuggerUtil,
  DEBUG_HEADER_LAYOUT,
  DEBUG_VIEW_RENDER,
} from '../common/debug';
import type {
  AdjustLeafNodesParams,
  CellCustomSize,
  FrameConfig,
  GridInfo,
  HiddenColumnsInfo,
  LayoutResult,
  OffsetConfig,
  S2CellType,
  ScrollChangeParams,
  ViewMeta,
} from '../common/interface';
import type {
  CellScrollOffset,
  CellScrollPosition,
  ScrollOffset,
} from '../common/interface/scroll';
import type { FrozenGroup } from '../group/frozen-group';
import { PanelScrollGroup } from '../group/panel-scroll-group';
import type { SpreadSheet } from '../sheet-type';
import { ScrollBar, ScrollType } from '../ui/scrollbar';
import { getAdjustedRowScrollX, getAdjustedScrollOffset } from '../utils/facet';
import { getAllChildCells } from '../utils/get-all-child-cells';
import { getColsForGrid, getRowsForGrid } from '../utils/grid';
import { diffPanelIndexes, type PanelIndexes } from '../utils/indexes';
import { isMobile } from '../utils/is-mobile';
import { CornerBBox } from './bbox/cornerBBox';
import { PanelBBox } from './bbox/panelBBox';
import {
  ColHeader,
  CornerHeader,
  Frame,
  RowHeader,
  SeriesNumberHeader,
} from './header';
import type { ViewCellHeights } from './layout/interface';
import type { Node } from './layout/node';
import { WheelEvent as MobileWheel } from './mobile/wheelEvent';
import {
  calculateInViewIndexes,
  getCellRange,
  optimizeScrollXY,
  translateGroup,
} from './utils';

export abstract class BaseFacet {
  // spreadsheet instance
  public spreadsheet: SpreadSheet;

  // corner box
  public cornerBBox: CornerBBox;

  // viewport cells box
  public panelBBox: PanelBBox;

  // background (useless now)
  public backgroundGroup: Group;

  // render viewport cell
  public panelGroup: Group;

  public panelScrollGroup: PanelScrollGroup;

  public frozenRowGroup: FrozenGroup;

  public frozenColGroup: FrozenGroup;

  public frozenTrailingRowGroup: FrozenGroup;

  public frozenTrailingColGroup: FrozenGroup;

  public frozenTopGroup: FrozenGroup;

  public frozenBottomGroup: FrozenGroup;

  // render header/corner/scrollbar/resize
  public foregroundGroup: Group;

  public layoutResult: LayoutResult;

  public viewCellWidths: number[];

  public viewCellHeights: ViewCellHeights;

  protected mobileWheel: MobileWheel;

  protected timer: Timer;

  public hScrollBar: ScrollBar;

  public hRowScrollBar: ScrollBar;

  public vScrollBar: ScrollBar;

  public rowHeader: RowHeader | null;

  public columnHeader: ColHeader;

  public cornerHeader: CornerHeader;

  public seriesNumberHeader: SeriesNumberHeader | null;

  public centerFrame: Frame;

  public gridInfo: GridInfo;

  protected abstract doLayout(): LayoutResult;

  public abstract getViewCellHeights(
    layoutResult: LayoutResult,
  ): ViewCellHeights;

  protected scrollFrameId: ReturnType<typeof requestAnimationFrame> | null =
    null;

  get scrollBarTheme() {
    return this.spreadsheet.theme.scrollBar;
  }

  get scrollBarSize() {
    return this.scrollBarTheme?.size!;
  }

  protected preCellIndexes: PanelIndexes | null;

  public constructor(spreadsheet: SpreadSheet) {
    this.spreadsheet = spreadsheet;
    this.init();
  }

  protected initGroups() {
    const container = this.spreadsheet.container;

    // the main three layer groups
    this.backgroundGroup = container.appendChild(
      new Group({
        name: KEY_GROUP_BACK_GROUND,
        style: { zIndex: BACK_GROUND_GROUP_CONTAINER_Z_INDEX },
      }),
    );

    this.initPanelGroups();
    this.foregroundGroup = container.appendChild(
      new Group({
        name: KEY_GROUP_FORE_GROUND,
        style: { zIndex: FRONT_GROUND_GROUP_CONTAINER_Z_INDEX },
      }),
    );
  }

  protected initPanelGroups() {
    const container = this.spreadsheet.container;

    this.panelGroup = container.appendChild(
      new Group({
        name: KEY_GROUP_PANEL_GROUND,
        style: { zIndex: PANEL_GROUP_GROUP_CONTAINER_Z_INDEX },
      }),
    );
    this.panelScrollGroup = new PanelScrollGroup({
      name: KEY_GROUP_PANEL_SCROLL,
      zIndex: PANEL_GROUP_SCROLL_GROUP_Z_INDEX,
      s2: this.spreadsheet,
    });
    this.panelGroup.add(this.panelScrollGroup);
  }

  protected getCellCustomSize(node: Node | null, size: CellCustomSize) {
    return isFunction(size) ? size?.(node) : size;
  }

  protected getRowCellDraggedWidth(node: Node): number | undefined {
    const { rowCell } = this.spreadsheet.options.style!;

    return (
      rowCell?.widthByField?.[node?.id] ?? rowCell?.widthByField?.[node?.field]
    );
  }

  protected getRowCellDraggedHeight(node: Node): number | undefined {
    const { rowCell } = this.spreadsheet.options.style!;

    return (
      rowCell?.heightByField?.[node?.id] ??
      rowCell?.heightByField?.[node?.field]
    );
  }

  protected getRowCellHeight(node: Node): number {
    const { rowCell, dataCell } = this.spreadsheet.options.style!;

    // 优先级: 行头拖拽 > 行头自定义高度 > 通用单元格高度
    return (
      this.getRowCellDraggedHeight(node) ??
      this.getCellCustomSize(node, rowCell?.height) ??
      dataCell?.height ??
      0
    );
  }

  protected getColCellDraggedWidth(node: Node): number | undefined {
    const { colCell } = this.spreadsheet.options.style!;

    return (
      colCell?.widthByField?.[node?.id] ?? colCell?.widthByField?.[node?.field]
    );
  }

  protected getColCellDraggedHeight(node: Node): number | undefined {
    const { colCell } = this.spreadsheet.options.style!;

    return (
      colCell?.heightByField?.[node?.id] ??
      colCell?.heightByField?.[node?.field]
    );
  }

  protected getDefaultColNodeHeight(colNode: Node): number {
    const { colCell } = this.spreadsheet.options.style!;

    // 优先级: 列头拖拽 > 列头自定义高度 > 通用单元格高度
    return (
      this.getColCellDraggedHeight(colNode) ??
      this.getCellCustomSize(colNode, colCell?.height) ??
      0
    );
  }

  hideScrollBar = () => {
    this.hRowScrollBar?.setAttribute('visibility', 'hidden');
    this.hScrollBar?.setAttribute('visibility', 'hidden');
    this.vScrollBar?.setAttribute('visibility', 'hidden');
  };

  delayHideScrollBar = debounce(this.hideScrollBar, 1000);

  delayHideScrollbarOnMobile = () => {
    if (isMobile()) {
      this.delayHideScrollBar();
    }
  };

  showVerticalScrollBar = () => {
    this.vScrollBar?.setAttribute('visibility', 'visible');
  };

  showHorizontalScrollBar = () => {
    this.hRowScrollBar?.setAttribute('visibility', 'visible');
    this.hScrollBar?.setAttribute('visibility', 'visible');
  };

  onContainerWheel = () => {
    if (isMobile()) {
      this.onContainerWheelForMobile();
    } else {
      this.onContainerWheelForPc();
    }
  };

  onContainerWheelForPc = () => {
    const canvas = this.spreadsheet.getCanvasElement();

    canvas?.addEventListener('wheel', this.onWheel);
  };

  onContainerWheelForMobile = () => {
    this.mobileWheel = new MobileWheel(this.spreadsheet.container);
    this.mobileWheel.on('wheel', (ev: FederatedWheelEvent) => {
      this.spreadsheet.hideTooltip();
      const originEvent = ev.originalEvent;
      const { deltaX, deltaY, x, y } = ev;

      // The coordinates of mobile and pc are three times different
      this.onWheel({
        ...originEvent,
        deltaX,
        deltaY,
        offsetX: x,
        offsetY: y,
      } as unknown as WheelEvent);
    });
  };

  bindEvents = () => {
    this.onContainerWheel();
    this.emitPaginationEvent();
  };

  /**
   * Start render, call from outside
   */
  public render() {
    this.adjustScrollOffset();
    this.renderHeaders();
    this.renderScrollBars();
    this.renderBackground();
    this.dynamicRenderCell();
  }

  /**
   * 在每次render, 校验scroll offset是否在合法范围中
   * 比如在滚动条已经滚动到100%的状态的前提下：（ maxAvailableScrollOffsetX = colsHierarchy.width - viewportBBox.width ）
   *     此时changeSheetSize，sheet从 small width 变为 big width
   *     导致后者 viewport 区域更大，其结果就是后者的 maxAvailableScrollOffsetX 更小
   *     此时就需要重置 scrollOffsetX，否则就会导致滚动过多，出现空白区域
   */
  protected adjustScrollOffset() {
    const offset = this.getAdjustedScrollOffset(this.getScrollOffset());

    this.setScrollOffset(offset);
  }

  public getSeriesNumberWidth(): number {
    const { showSeriesNumber } = this.spreadsheet.options;

    return showSeriesNumber
      ? this.spreadsheet.theme.rowCell?.seriesNumberWidth ?? 0
      : 0;
  }

  public getCanvasSize() {
    const { width = 0, height = 0 } = this.spreadsheet.options!;

    return {
      width,
      height,
    };
  }

  public getContentHeight(): number {
    const { rowsHierarchy, colsHierarchy } = this.layoutResult;

    return rowsHierarchy.height + colsHierarchy.height;
  }

  public updateScrollOffset(offsetConfig: OffsetConfig) {
    if (offsetConfig.rowHeaderOffsetX?.value !== undefined) {
      if (offsetConfig.rowHeaderOffsetX?.animate) {
        this.scrollWithAnimation(offsetConfig);
      } else {
        this.scrollImmediately(offsetConfig);
      }

      return;
    }

    if (offsetConfig.offsetX?.value !== undefined) {
      if (offsetConfig.offsetX?.animate) {
        this.scrollWithAnimation(offsetConfig);
      } else {
        this.scrollImmediately(offsetConfig);
      }

      return;
    }

    if (offsetConfig.offsetY?.value !== undefined) {
      if (offsetConfig.offsetY?.animate) {
        this.scrollWithAnimation(offsetConfig);
      } else {
        this.scrollImmediately(offsetConfig);
      }
    }
  }

  public getPaginationScrollY(): number {
    const { pagination } = this.spreadsheet.options!;

    if (pagination) {
      const { current = DEFAULT_PAGE_INDEX, pageSize } = pagination;
      const heights = this.viewCellHeights;
      const offset = Math.max((current - 1) * pageSize, 0);

      return heights.getCellOffsetY(offset);
    }

    return 0;
  }

  public destroy() {
    this.unbindEvents();
    this.clearAllGroup();
    this.preCellIndexes = null;
    cancelAnimationFrame(this.scrollFrameId!);
  }

  public setScrollOffset = (scrollOffset: ScrollOffset) => {
    Object.keys(scrollOffset).forEach((key) => {
      const offset = get(scrollOffset, key);

      if (!isUndefined(offset)) {
        this.spreadsheet.store.set(key, Math.floor(offset));
      }
    });
  };

  public getScrollOffset = (): Required<ScrollOffset> => {
    const { store } = this.spreadsheet;

    return {
      scrollX: store.get<keyof ScrollOffset>('scrollX', 0),
      scrollY: store.get<keyof ScrollOffset>('scrollY', 0),
      rowHeaderScrollX: store.get<keyof ScrollOffset>('rowHeaderScrollX', 0),
    };
  };

  public resetScrollX = () => {
    this.setScrollOffset({ scrollX: 0 });
  };

  public resetRowScrollX = () => {
    this.setScrollOffset({ hRowScrollX: 0 });
  };

  public resetScrollY = () => {
    this.setScrollOffset({ scrollY: 0 });
  };

  public resetScrollOffset = () => {
    this.setScrollOffset({ scrollX: 0, scrollY: 0, hRowScrollX: 0 });
  };

  emitPaginationEvent = () => {
    const { pagination } = this.spreadsheet.options!;

    if (pagination) {
      const { current = DEFAULT_PAGE_INDEX, pageSize } = pagination;
      const total = this.viewCellHeights.getTotalLength();

      const pageCount = Math.floor((total - 1) / pageSize) + 1;

      this.spreadsheet.emit(S2Event.LAYOUT_PAGINATION, {
        pageSize,
        pageCount,
        total,
        current,
      });
    }
  };

  private unbindEvents = () => {
    const canvas = this.spreadsheet.getCanvasElement();

    canvas?.removeEventListener('wheel', this.onWheel);
    this.mobileWheel?.destroy();
  };

  calculateCellWidthHeight = () => {
    const { colLeafNodes } = this.layoutResult;
    const widths = reduce(
      colLeafNodes,
      (result: number[], node: Node) => {
        const width = last(result) || 0;

        result.push(width + node.width);

        return result;
      },
      [0],
    );

    this.viewCellWidths = widths;
    this.viewCellHeights = this.getViewCellHeights(this.layoutResult);
  };

  /**
   * The purpose of this rewrite is to take into account that when rowHeader supports scrollbars
   *the panel viewable area must vary with the horizontal distance of the scroll
   * @param scrollX
   * @param scrollY
   * @public
   */
  public calculateXYIndexes(scrollX: number, scrollY: number): PanelIndexes {
    const { viewportHeight: height, viewportWidth: width } = this.panelBBox;

    const indexes = calculateInViewIndexes({
      scrollX,
      scrollY,
      widths: this.viewCellWidths,
      heights: this.viewCellHeights,
      viewport: {
        width,
        height,
        x: 0,
        y: 0,
      },
      rowRemainWidth: this.getRealScrollX(this.cornerBBox.width),
    });

    return {
      center: indexes,
    };
  }

  getRealScrollX = (scrollX: number, hRowScroll = 0) =>
    this.spreadsheet.isFrozenRowHeader() ? hRowScroll : scrollX;

  protected calculateCornerBBox() {
    this.cornerBBox = new CornerBBox(this, true);
  }

  protected calculatePanelBBox = () => {
    this.panelBBox = new PanelBBox(this, true);
  };

  getRealWidth = (): number => last(this.viewCellWidths) || 0;

  getCellRange() {
    const { pagination } = this.spreadsheet.options!;

    return getCellRange(this.viewCellHeights, pagination);
  }

  getRealHeight = (): number => {
    const { pagination } = this.spreadsheet.options!;
    const heights = this.viewCellHeights;

    if (pagination) {
      const { start, end } = this.getCellRange();

      return heights.getCellOffsetY(end + 1) - heights.getCellOffsetY(start);
    }

    return heights.getTotalHeight();
  };

  clearAllGroup() {
    const { children = [] } = this.panelGroup;

    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];

      if (child instanceof Group) {
        child.removeChildren();
      } else {
        children[i].remove();
      }
    }

    this.foregroundGroup.removeChildren();
    this.backgroundGroup.removeChildren();
  }

  scrollWithAnimation = (
    offsetConfig: OffsetConfig = {},
    duration = 200,
    cb?: () => void,
  ) => {
    const {
      scrollX: adjustedScrollX,
      scrollY: adjustedScrollY,
      rowHeaderScrollX: adjustedRowScrollX,
    } = this.getAdjustedScrollOffset({
      scrollX: offsetConfig.offsetX?.value || 0,
      scrollY: offsetConfig.offsetY?.value || 0,
      rowHeaderScrollX: offsetConfig.rowHeaderOffsetX?.value || 0,
    });

    this.timer?.stop();

    const scrollOffset = this.getScrollOffset();

    const newOffset: number[] = [
      adjustedScrollX ?? scrollOffset.scrollX,
      adjustedScrollY ?? scrollOffset.scrollY,
      adjustedRowScrollX ?? scrollOffset.rowHeaderScrollX,
    ];
    const interpolate = interpolateArray(
      Object.values(scrollOffset),
      newOffset,
    );

    this.timer = timer((elapsed) => {
      const ratio = Math.min(elapsed / duration, 1);
      const [scrollX, scrollY, rowHeaderScrollX] = interpolate(ratio);

      this.setScrollOffset({
        rowHeaderScrollX,
        scrollX,
        scrollY,
      });
      this.startScroll();

      if (elapsed > duration) {
        this.timer.stop();
        cb?.();
      }
    });
  };

  scrollImmediately = (offsetConfig: OffsetConfig = {}) => {
    const { scrollX, scrollY, rowHeaderScrollX } = this.getAdjustedScrollOffset(
      {
        scrollX: offsetConfig.offsetX?.value || 0,
        scrollY: offsetConfig.offsetY?.value || 0,
        rowHeaderScrollX: offsetConfig.rowHeaderOffsetX?.value || 0,
      },
    );

    this.setScrollOffset({ scrollX, scrollY, rowHeaderScrollX });
    this.startScroll();
  };

  /**
   *
   * @param skipScrollEvent 不触发 S2Event.GLOBAL_SCROLL
   */
  startScroll = (skipScrollEvent = false) => {
    const { rowHeaderScrollX, scrollX, scrollY } = this.getScrollOffset();

    this.hRowScrollBar?.onlyUpdateThumbOffset(
      this.getScrollBarOffset(rowHeaderScrollX, this.hRowScrollBar),
    );

    this.hScrollBar?.onlyUpdateThumbOffset(
      this.getScrollBarOffset(scrollX, this.hScrollBar),
    );

    this.vScrollBar?.onlyUpdateThumbOffset(
      this.getScrollBarOffset(scrollY, this.vScrollBar),
    );
    this.dynamicRenderCell(skipScrollEvent);
  };

  getRendererHeight = () => {
    const { start, end } = this.getCellRange();

    return (
      this.viewCellHeights.getCellOffsetY(end + 1) -
      this.viewCellHeights.getCellOffsetY(start)
    );
  };

  private getAdjustedScrollOffset = ({
    scrollX,
    scrollY,
    rowHeaderScrollX,
  }: ScrollOffset): ScrollOffset => {
    return {
      scrollX: getAdjustedScrollOffset(
        scrollX!,
        this.layoutResult.colsHierarchy.width,
        this.panelBBox.width,
      ),
      scrollY: getAdjustedScrollOffset(
        scrollY!,
        this.getRendererHeight(),
        this.panelBBox.height,
      ),
      rowHeaderScrollX: getAdjustedRowScrollX(
        rowHeaderScrollX!,
        this.cornerBBox,
      ),
    };
  };

  renderRowScrollBar = (rowHeaderScrollX: number) => {
    if (
      this.spreadsheet.isFrozenRowHeader() &&
      this.cornerBBox.width < this.cornerBBox.originalWidth
    ) {
      const maxOffset = this.cornerBBox.originalWidth - this.cornerBBox.width;
      const { maxY } = this.getScrollbarPosition();
      const { splitLine, scrollBar } = this.spreadsheet.theme;

      const thumbSize = Math.max(
        (this.cornerBBox.width * this.cornerBBox.width) /
          this.cornerBBox.originalWidth,
        scrollBar?.thumbHorizontalMinSize!,
      );

      // 行头有分割线, 滚动条应该预留分割线的宽度
      const displayThumbSize = thumbSize - splitLine?.verticalBorderWidth!;

      this.hRowScrollBar = new ScrollBar({
        isHorizontal: true,
        trackLen: this.cornerBBox.width,
        thumbLen: displayThumbSize,
        position: {
          x: this.cornerBBox.minX + this.scrollBarSize! / 2,
          y: maxY,
        },
        thumbOffset:
          (rowHeaderScrollX * (this.cornerBBox.width - thumbSize)) / maxOffset,
        theme: this.scrollBarTheme,
        scrollTargetMaxOffset: maxOffset,
      });

      this.hRowScrollBar.on(
        ScrollType.ScrollChange,
        ({ offset }: ScrollChangeParams) => {
          const newOffset = this.getValidScrollBarOffset(offset, maxOffset);
          const rowHeaderScrollX = Math.floor(newOffset);

          this.setScrollOffset({ rowHeaderScrollX });

          this.rowHeader?.onRowScrollX(
            rowHeaderScrollX,
            KEY_GROUP_ROW_RESIZE_AREA,
          );
          this.rowIndexHeader?.onRowScrollX(
            rowHeaderScrollX,
            KEY_GROUP_ROW_INDEX_RESIZE_AREA,
          );
          this.cornerHeader.onRowScrollX(
            rowHeaderScrollX,
            KEY_GROUP_CORNER_RESIZE_AREA,
          );

          const scrollBarOffsetX = this.getScrollBarOffset(
            rowHeaderScrollX,
            this.hRowScrollBar,
          );

          const { scrollX, scrollY } = this.getScrollOffset();
          const position: CellScrollPosition = {
            scrollX,
            scrollY,
            rowHeaderScrollX: scrollBarOffsetX,
          };

          this.hRowScrollBar.updateThumbOffset(scrollBarOffsetX, false);
          this.spreadsheet.emit(S2Event.ROW_CELL_SCROLL, position);
          this.spreadsheet.emit(S2Event.GLOBAL_SCROLL, position);
        },
      );
      this.foregroundGroup.appendChild(this.hRowScrollBar);
    }
  };

  getValidScrollBarOffset = (offset: number, maxOffset: number) =>
    clamp(offset, 0, maxOffset);

  renderHScrollBar = (width: number, realWidth: number, scrollX: number) => {
    if (Math.floor(width) < Math.floor(realWidth)) {
      const halfScrollSize = this.scrollBarSize / 2;
      const { maxY } = this.getScrollbarPosition();
      const isScrollContainsRowHeader = !this.spreadsheet.isFrozenRowHeader();
      const finalWidth =
        width +
        (isScrollContainsRowHeader
          ? Math.min(this.cornerBBox.width, this.getCanvasSize().width)
          : 0);
      const finalPosition = {
        x:
          this.panelBBox.minX +
          (isScrollContainsRowHeader
            ? -this.cornerBBox.width + halfScrollSize
            : halfScrollSize),
        y: maxY,
      };
      const finaleRealWidth =
        realWidth + (isScrollContainsRowHeader ? this.cornerBBox.width : 0);

      const { scrollBar } = this.spreadsheet.theme;
      const maxOffset = finaleRealWidth - finalWidth;
      const thumbLen = Math.max(
        (finalWidth / finaleRealWidth) * finalWidth,
        scrollBar?.thumbHorizontalMinSize!,
      );

      // TODO abstract
      this.hScrollBar = new ScrollBar({
        isHorizontal: true,
        trackLen: finalWidth,
        thumbLen,
        position: finalPosition,
        thumbOffset: (scrollX * (finalWidth - thumbLen)) / maxOffset,
        theme: this.scrollBarTheme,
        scrollTargetMaxOffset: maxOffset,
      });

      this.hScrollBar.addEventListener(
        ScrollType.ScrollChange,
        ({ offset, updateThumbOffset }: ScrollChangeParams) => {
          const newScrollX = this.getValidScrollBarOffset(offset, maxOffset);

          if (updateThumbOffset) {
            this.hScrollBar.updateThumbOffset(
              this.getScrollBarOffset(newScrollX, this.hScrollBar),
              false,
            );
          }

          this.setScrollOffset({
            scrollX: newScrollX,
          });
          this.dynamicRenderCell();
        },
      );

      this.foregroundGroup.appendChild(this.hScrollBar);
    }
  };

  private getScrollbarPosition = () => {
    const { maxX, maxY } = this.panelBBox;
    const { width, height } = this.getCanvasSize();
    const isContentMode =
      this.spreadsheet.options.interaction!.scrollbarPosition ===
      ScrollbarPositionType.CONTENT;

    return {
      maxX: (isContentMode ? maxX : width) - this.scrollBarSize,
      maxY: isContentMode ? maxY : height - this.scrollBarSize,
    };
  };

  renderVScrollBar = (height: number, realHeight: number, scrollY: number) => {
    if (height < realHeight) {
      const { scrollBar } = this.spreadsheet.theme;
      const thumbLen = Math.max(
        (height / realHeight) * height,
        scrollBar?.thumbVerticalMinSize!,
      );
      const maxOffset = realHeight - height;
      const { maxX } = this.getScrollbarPosition();

      this.vScrollBar = new ScrollBar({
        isHorizontal: false,
        trackLen: height,
        thumbLen,
        thumbOffset: (scrollY * (height - thumbLen)) / maxOffset,
        position: {
          x: maxX,
          y: this.panelBBox.minY,
        },
        theme: this.scrollBarTheme,
        scrollTargetMaxOffset: maxOffset,
      });

      this.vScrollBar.addEventListener(
        ScrollType.ScrollChange,
        ({ offset, updateThumbOffset }: ScrollChangeParams) => {
          const newScrollY = this.getValidScrollBarOffset(offset, maxOffset);

          if (updateThumbOffset) {
            this.vScrollBar.updateThumbOffset(
              this.getScrollBarOffset(newScrollY, this.vScrollBar),
              false,
            );
          }

          this.setScrollOffset({ scrollY: newScrollY });
          this.dynamicRenderCell();
        },
      );

      this.foregroundGroup.appendChild(this.vScrollBar);
    }
  };

  // (滑动 offset / 最大 offset（滚动对象真正长度 - 轨道长）) = (滑块 offset / 最大滑动距离（轨道长 - 滑块长）)
  getScrollBarOffset = (offset: number, scrollbar: ScrollBar) => {
    const { trackLen, thumbLen, scrollTargetMaxOffset } = scrollbar;

    return (offset * (trackLen - thumbLen)) / scrollTargetMaxOffset;
  };

  isScrollOverThePanelArea = ({ offsetX, offsetY }: CellScrollOffset) =>
    offsetX > this.panelBBox.minX &&
    offsetX < this.panelBBox.maxX &&
    offsetY > this.panelBBox.minY &&
    offsetY < this.panelBBox.maxY;

  isScrollOverTheCornerArea = ({ offsetX, offsetY }: CellScrollOffset) =>
    offsetX > this.cornerBBox.minX &&
    offsetX < this.cornerBBox.maxX &&
    offsetY > this.cornerBBox.minY &&
    offsetY < this.cornerBBox.maxY + this.panelBBox.height;

  updateHorizontalRowScrollOffset = ({
    offset,
    offsetX,
    offsetY,
  }: CellScrollOffset) => {
    // 在行头区域滚动时 才更新行头水平滚动条
    if (this.isScrollOverTheCornerArea({ offsetX, offsetY })) {
      this.hRowScrollBar?.emitScrollChange(offset!);
    }
  };

  updateHorizontalScrollOffset = ({
    offset,
    offsetX,
    offsetY,
  }: CellScrollOffset) => {
    // 1.行头没有滚动条 2.在数值区域滚动时 才更新数值区域水平滚动条
    if (
      !this.hRowScrollBar ||
      this.isScrollOverThePanelArea({ offsetX, offsetY })
    ) {
      this.hScrollBar?.emitScrollChange(offset!);
    }
  };

  isScrollToLeft = ({ deltaX, offsetX, offsetY }: CellScrollOffset) => {
    if (!this.hScrollBar && !this.hRowScrollBar) {
      return true;
    }

    const isScrollRowHeaderToLeft =
      !this.hRowScrollBar ||
      this.isScrollOverThePanelArea({ offsetY, offsetX }) ||
      this.hRowScrollBar.thumbOffset <= 0;

    const isScrollPanelToLeft =
      !this.hScrollBar || this.hScrollBar.thumbOffset <= 0;

    return deltaX! <= 0 && isScrollPanelToLeft && isScrollRowHeaderToLeft;
  };

  isScrollToRight = ({ deltaX, offsetX, offsetY }: CellScrollOffset) => {
    if (!this.hScrollBar && !this.hRowScrollBar) {
      return true;
    }

    const viewportWidth = this.spreadsheet.isFrozenRowHeader()
      ? this.panelBBox?.width
      : this.panelBBox?.maxX;

    const isScrollRowHeaderToRight =
      !this.hRowScrollBar ||
      this.isScrollOverThePanelArea({ offsetY, offsetX }) ||
      this.hRowScrollBar?.thumbOffset + this.hRowScrollBar?.thumbLen >=
        this.cornerBBox.width;

    const isScrollPanelToRight =
      (this.hRowScrollBar &&
        this.isScrollOverTheCornerArea({ offsetX, offsetY })) ||
      this.hScrollBar?.thumbOffset + this.hScrollBar?.thumbLen >= viewportWidth;

    return deltaX! >= 0 && isScrollPanelToRight && isScrollRowHeaderToRight;
  };

  isScrollToTop = (deltaY: number) => {
    if (!this.vScrollBar) {
      return true;
    }

    return deltaY <= 0 && this.vScrollBar?.thumbOffset <= 0;
  };

  isScrollToBottom = (deltaY: number) => {
    if (!this.vScrollBar) {
      return true;
    }

    return (
      deltaY >= 0 &&
      this.vScrollBar?.thumbOffset + this.vScrollBar?.thumbLen >=
        this.panelBBox?.height
    );
  };

  isVerticalScrollOverTheViewport = (deltaY: number) =>
    !this.isScrollToTop(deltaY) && !this.isScrollToBottom(deltaY);

  isHorizontalScrollOverTheViewport = (scrollOffset: CellScrollOffset) =>
    !this.isScrollToLeft(scrollOffset) && !this.isScrollToRight(scrollOffset);

  /**
   * 在当前表格滚动分两种情况:
   *  1. 当前表格无滚动条: 无需阻止外部容器滚动
   *  2. 当前表格有滚动条:
   *    - 未滚动到顶部或底部: 当前表格滚动, 阻止外部容器滚动
   *    - 滚动到顶部或底部: 恢复外部容器滚动
   */
  isScrollOverTheViewport = (scrollOffset: CellScrollOffset) => {
    const { deltaY, deltaX, offsetY } = scrollOffset;
    const isScrollOverTheHeader = offsetY <= this.cornerBBox.maxY;

    // 光标在角头或列头时, 不触发表格自身滚动
    if (isScrollOverTheHeader) {
      return false;
    }

    if (deltaY !== 0) {
      return this.isVerticalScrollOverTheViewport(deltaY!);
    }

    if (deltaX !== 0) {
      return this.isHorizontalScrollOverTheViewport(scrollOffset);
    }

    return false;
  };

  cancelScrollFrame = () => {
    if (isMobile() && this.scrollFrameId) {
      return false;
    }

    cancelAnimationFrame(this.scrollFrameId!);

    return true;
  };

  clearScrollFrameIdOnMobile = () => {
    if (isMobile()) {
      this.scrollFrameId = null;
    }
  };

  /**
   *<<<<<<< HEAD
   *https://developer.mozilla.org/zh-CN/docs/Web/CSS/overscroll-behavior
   *阻止外部容器滚动: 表格是虚拟滚动, 这里按照标准模拟浏览器的 [overscroll-behavior] 实现
   *1. auto => 只有在滚动到表格顶部或底部时才触发外部容器滚动
   *1. contain => 默认的滚动边界行为不变（“触底”效果或者刷新），但是临近的滚动区域不会被滚动链影响到
   *2. none => 临近滚动区域不受到滚动链影响，而且默认的滚动到边界的表现也被阻止
   *所以只要不为 `auto`, 或者表格内, 都需要阻止外部容器滚动
   *=======
   *https://developer.mozilla.org/zh-CN/docs/Web/CSS/overscroll-behavior
   *阻止外部容器滚动: 表格是虚拟滚动, 这里按照标准模拟浏览器的 [overscroll-behavior] 实现
   *1. auto => 只有在滚动到表格顶部或底部时才触发外部容器滚动
   *1. contain => 默认的滚动边界行为不变（“触底”效果或者刷新），但是临近的滚动区域不会被滚动链影响到
   *2. none => 临近滚动区域不受到滚动链影响，而且默认的滚动到边界的表现也被阻止
   *所以只要不为 `auto`, 或者表格内, 都需要阻止外部容器滚动
   *>>>>>>> next
   */
  private stopScrollChainingIfNeeded = (event: WheelEvent) => {
    const { interaction } = this.spreadsheet.options;

    if (interaction?.overscrollBehavior !== 'auto') {
      this.stopScrollChaining(event);
    }
  };

  private stopScrollChaining = (event: WheelEvent) => {
    event?.preventDefault?.();
    // 移动端的 prevent 存在于 originalEvent上
    (event as unknown as GraphEvent)?.originalEvent?.preventDefault?.();
  };

  onWheel = (event: WheelEvent) => {
    const { interaction } = this.spreadsheet.options;
    let { deltaX, deltaY, offsetX, offsetY } = event;
    const { shiftKey } = event;

    // 按住shift时，固定为水平方向滚动
    if (shiftKey) {
      offsetX = offsetX - deltaX + deltaY;
      deltaX = deltaY;
      offsetY -= deltaY;
      deltaY = 0;
    }

    const [optimizedDeltaX, optimizedDeltaY] = optimizeScrollXY(
      deltaX,
      deltaY,
      interaction?.scrollSpeedRatio!,
    );

    this.spreadsheet.hideTooltip();
    this.spreadsheet.interaction.clearHoverTimer();

    if (
      !this.isScrollOverTheViewport({
        deltaX: optimizedDeltaX,
        deltaY: optimizedDeltaY,
        offsetX,
        offsetY,
      })
    ) {
      this.stopScrollChainingIfNeeded(event);

      return;
    }

    this.stopScrollChaining(event);

    this.spreadsheet.interaction.addIntercepts([InterceptType.HOVER]);

    if (!this.cancelScrollFrame()) {
      return;
    }

    this.scrollFrameId = requestAnimationFrame(() => {
      const {
        scrollX: currentScrollX,
        scrollY: currentScrollY,
        rowHeaderScrollX,
      } = this.getScrollOffset();

      if (optimizedDeltaX !== 0) {
        this.showHorizontalScrollBar();
        this.updateHorizontalRowScrollOffset({
          offsetX,
          offsetY,
          offset: optimizedDeltaX + rowHeaderScrollX,
        });
        this.updateHorizontalScrollOffset({
          offsetX,
          offsetY,
          offset: optimizedDeltaX + currentScrollX,
        });
      }

      if (optimizedDeltaY !== 0) {
        this.showVerticalScrollBar();
        this.vScrollBar?.emitScrollChange(optimizedDeltaY + currentScrollY);
      }

      this.delayHideScrollbarOnMobile();
      this.clearScrollFrameIdOnMobile();
    });
  };

  /**
   * Translate panelGroup, rowHeader, cornerHeader, columnHeader ect
   * according to new scroll offset
   * @param scrollX
   * @param scrollY
   * @param hRowScroll
   * @protected
   */
  protected translateRelatedGroups(
    scrollX: number,
    scrollY: number,
    hRowScroll: number,
  ) {
    translateGroup(
      this.panelScrollGroup,
      this.panelBBox.x - scrollX,
      this.panelBBox.y - scrollY,
    );
    this.rowHeader?.onScrollXY(
      this.getRealScrollX(scrollX, hRowScroll),
      scrollY,
      KEY_GROUP_ROW_RESIZE_AREA,
    );
    this.seriesNumberHeader?.onScrollXY(
      this.getRealScrollX(scrollX, hRowScroll),
      scrollY,
      KEY_GROUP_ROW_INDEX_RESIZE_AREA,
    );
    this.cornerHeader.onCorScroll(
      this.getRealScrollX(scrollX, hRowScroll),
      KEY_GROUP_CORNER_RESIZE_AREA,
    );
    this.centerFrame.onChangeShadowVisibility(
      scrollX,
      this.getRealWidth() - this.panelBBox.width,
    );
    this.centerFrame.onBorderScroll(this.getRealScrollX(scrollX));
    this.columnHeader.onColScroll(scrollX, KEY_GROUP_COL_RESIZE_AREA);
  }

  addCell = (cell: S2CellType<ViewMeta>) => {
    this.panelScrollGroup?.appendChild(cell);
    this.spreadsheet.emit(S2Event.LAYOUT_CELL_MOUNTED, cell);
  };

  realCellRender = (scrollX: number, scrollY: number) => {
    const indexes = this.calculateXYIndexes(scrollX, scrollY);

    DebuggerUtil.getInstance().logger(
      'realCellRender:',
      this.preCellIndexes,
      indexes,
    );
    const { add, remove } = diffPanelIndexes(this.preCellIndexes!, indexes);

    DebuggerUtil.getInstance().debugCallback(DEBUG_VIEW_RENDER, () => {
      // add new cell in panelCell
      each(add, ([i, j]) => {
        const viewMeta = this.layoutResult.getCellMeta(j, i);

        if (viewMeta) {
          const cell = this.spreadsheet.options.dataCell?.(viewMeta)!;

          // mark cell for removing
          cell.name = `${i}-${j}`;
          this.addCell(cell);
        }
      });
      const allCells = getAllChildCells(
        this.panelGroup.children,
        DataCell,
      ) as DataCell[];

      // remove cell from panelCell
      each(remove, ([i, j]) => {
        const findOne = find(allCells, (cell) => cell.name === `${i}-${j}`);

        findOne?.remove();
      });

      DebuggerUtil.getInstance().logger(
        `Render Cell Panel: ${allCells?.length}, Add: ${add?.length}, Remove: ${remove?.length}`,
      );
    });
    this.preCellIndexes = indexes;
    this.spreadsheet.emit(S2Event.LAYOUT_AFTER_REAL_DATA_CELL_RENDER, {
      add,
      remove,
      spreadsheet: this.spreadsheet,
    });
  };

  protected init() {
    this.initGroups();
    // layout
    DebuggerUtil.getInstance().debugCallback(DEBUG_HEADER_LAYOUT, () => {
      this.layoutResult = this.doLayout();
      this.saveInitColumnLeafNodes(this.layoutResult.colLeafNodes);
      this.spreadsheet.emit(
        S2Event.LAYOUT_AFTER_HEADER_LAYOUT,
        this.layoutResult,
      );
    });

    // all cell's width&height
    this.calculateCellWidthHeight();
    this.calculateCornerBBox();
    this.calculatePanelBBox();
    this.bindEvents();
  }

  protected renderBackground() {
    const { width, height } = this.getCanvasSize();
    const { color, opacity } = this.spreadsheet.theme.background!;

    this.backgroundGroup.appendChild(
      new Rect({
        style: {
          fill: color,
          opacity,
          x: 0,
          y: 0,
          width,
          height,
        },
      }),
    );
  }

  /**
   * Render all scrollbars, default horizontal scrollbar only control viewport
   * area(it means not contains row header)
   * 1. individual row scrollbar
   * 2. horizontal scroll bar(can control whether contains row header)
   * 3. vertical scroll bar
   */
  protected renderScrollBars() {
    const { scrollX, scrollY, rowHeaderScrollX } = this.getScrollOffset();
    const { width, height } = this.panelBBox;
    const realWidth = this.layoutResult.colsHierarchy.width;
    const realHeight = this.getRealHeight();

    // scroll row header separate from the whole canvas
    this.renderRowScrollBar(rowHeaderScrollX);

    // render horizontal scroll bar(default not contains row header)
    this.renderHScrollBar(width, realWidth, scrollX);

    // render vertical scroll bar
    this.renderVScrollBar(height, realHeight, scrollY);
  }

  /**
   * Render all headers in {@link #foregroundGroup}, contains:
   * 1. row header
   * 2. col header
   * 3. center frame
   * 4. corner header
   * 5. series number header
   */
  protected renderHeaders() {
    const seriesNumberWidth = this.getSeriesNumberWidth();

    this.rowHeader = this.getRowHeader();
    this.columnHeader = this.getColHeader();
    if (seriesNumberWidth > 0 && !this.seriesNumberHeader) {
      this.seriesNumberHeader = this.getSeriesNumberHeader();
    }

    this.cornerHeader = this.getCornerHeader();
    this.centerFrame = this.getCenterFrame();

    if (this.seriesNumberHeader) {
      this.foregroundGroup.appendChild(this.seriesNumberHeader);
    }

    if (this.rowHeader) {
      this.foregroundGroup.appendChild(this.rowHeader);
    }

    this.foregroundGroup.appendChild(this.columnHeader);
    this.foregroundGroup.appendChild(this.cornerHeader);
    this.foregroundGroup.appendChild(this.centerFrame);
  }

  protected getRowHeader(): RowHeader | null {
    if (!this.rowHeader) {
      const { y, viewportHeight, viewportWidth, height } = this.panelBBox;
      const seriesNumberWidth = this.getSeriesNumberWidth();

      return new RowHeader({
        width: this.cornerBBox.width,
        height,
        viewportWidth,
        viewportHeight,
        position: { x: seriesNumberWidth, y },
        nodes: this.layoutResult.rowNodes,
        spreadsheet: this.spreadsheet,
      });
    }

    return this.rowHeader;
  }

  protected getColHeader(): ColHeader {
    if (!this.columnHeader) {
      const { x, width, viewportHeight, viewportWidth } = this.panelBBox;

      return new ColHeader({
        width,
        cornerWidth: this.cornerBBox.width,
        height: this.cornerBBox.height,
        viewportWidth,
        viewportHeight,
        position: { x, y: 0 },
        nodes: this.layoutResult.colNodes,
        sortParam: this.spreadsheet.store.get('sortParam'),
        spreadsheet: this.spreadsheet,
      });
    }

    return this.columnHeader;
  }

  protected getCornerHeader(): CornerHeader {
    if (!this.cornerHeader) {
      return CornerHeader.getCornerHeader({
        panelBBox: this.panelBBox,
        cornerBBox: this.cornerBBox,
        seriesNumberWidth: this.getSeriesNumberWidth(),
        layoutResult: this.layoutResult,
        spreadsheet: this.spreadsheet,
      });
    }

    return this.cornerHeader;
  }

  protected getSeriesNumberHeader(): SeriesNumberHeader | null {
    return SeriesNumberHeader.getSeriesNumberHeader({
      spreadsheet: this.spreadsheet,
      panelBBox: this.panelBBox,
      cornerWidth: this.cornerBBox.width,
      seriesNumberWidth: this.getSeriesNumberWidth(),
      rowsHierarchy: this.layoutResult.rowsHierarchy,
    });
  }

  protected getCenterFrame(): Frame {
    if (!this.centerFrame) {
      const { viewportWidth, viewportHeight } = this.panelBBox;
      const cornerWidth = this.cornerBBox.width;
      const cornerHeight = this.cornerBBox.height;
      const frame = this.spreadsheet.options?.frame;
      const frameCfg: FrameConfig = {
        position: {
          x: this.cornerBBox.x,
          y: this.cornerBBox.y,
        },
        cornerWidth,
        cornerHeight,
        viewportWidth,
        viewportHeight,
        showViewportLeftShadow: false,
        showViewportRightShadow: false,
        spreadsheet: this.spreadsheet,
      };

      return frame ? frame(frameCfg) : new Frame(frameCfg);
    }

    return this.centerFrame;
  }

  protected getGridInfo = () => {
    const [colMin, colMax, rowMin, rowMax] = this.preCellIndexes!.center;
    const cols = getColsForGrid(colMin, colMax, this.layoutResult.colLeafNodes);
    const rows = getRowsForGrid(rowMin, rowMax, this.viewCellHeights);

    return {
      cols,
      rows,
    };
  };

  public updatePanelScrollGroup() {
    this.gridInfo = this.getGridInfo();
    this.panelScrollGroup.update(this.gridInfo);
  }

  /**
   *
   * @param skipScrollEvent: 如true则不触发GLOBAL_SCROLL事件
   * During scroll behavior, first call to this method fires immediately and then on interval.
   * @protected
   */
  protected dynamicRenderCell(skipScrollEvent?: boolean) {
    const {
      scrollX,
      scrollY: originalScrollY,
      rowHeaderScrollX,
    } = this.getScrollOffset();
    const defaultScrollY = originalScrollY + this.getPaginationScrollY();
    const scrollY = getAdjustedScrollOffset(
      defaultScrollY,
      this.viewCellHeights.getTotalHeight(),
      this.panelBBox.viewportHeight,
    );

    this.spreadsheet.hideTooltip();
    this.spreadsheet.interaction.clearHoverTimer();

    this.realCellRender(scrollX, scrollY);
    this.updatePanelScrollGroup();
    this.translateRelatedGroups(scrollX, scrollY, rowHeaderScrollX);
    if (!skipScrollEvent) {
      this.emitScrollEvent({ scrollX, scrollY, rowHeaderScrollX });
    }

    this.onAfterScroll();
  }

  private emitScrollEvent(position: CellScrollPosition) {
    this.spreadsheet.emit(S2Event.GLOBAL_SCROLL, position);
  }

  protected onAfterScroll = debounce(() => {
    const { interaction } = this.spreadsheet;

    // 如果是选中单元格状态, 则继续保留 hover 拦截, 避免滚动后 hover 清空已选单元格
    if (!interaction.isSelectedState()) {
      this.spreadsheet.interaction.removeIntercepts([InterceptType.HOVER]);
    }
  }, 300);

  protected saveInitColumnLeafNodes(columnNodes: Node[] = []) {
    const { store, options } = this.spreadsheet;
    const { hiddenColumnFields = [] } = options.interaction!;

    // 当前显示的 + 被隐藏的
    const originalColumnsLength =
      columnNodes.length + hiddenColumnFields.length;
    const initColumnLeafNodes = store.get('initColumnLeafNodes', []);

    if (originalColumnsLength !== initColumnLeafNodes?.length) {
      store.set('initColumnLeafNodes', columnNodes);
    }
  }

  public getHiddenColumnsInfo(columnNode: Node): HiddenColumnsInfo | undefined {
    const hiddenColumnsDetail = this.spreadsheet.store.get(
      'hiddenColumnsDetail',
      [],
    );

    if (isEmpty(hiddenColumnsDetail)) {
      return;
    }

    return hiddenColumnsDetail.find((detail) =>
      detail.hideColumnNodes.some((node) => node.id === columnNode.id),
    );
  }

  public getCornerNodes(): Node[] {
    return this.cornerHeader?.getNodes() || [];
  }

  /**
   * @description 自定义行头时, 叶子节点层级不定, 需要自动对齐其宽度, 填充空白
   * -------------------------------------------------
   * |  自定义节点 a-1  |  自定义节点 a-1-1              |
   * |-------------   |-------------     |------------|
   * |  自定义节点 b-1  |  自定义节点 b-1-1 |  指标 1    |
   * -------------------------------------------------
   */
  public adjustRowLeafNodesWidth(params: AdjustLeafNodesParams) {
    if (!this.spreadsheet.isCustomRowFields()) {
      return;
    }

    this.adjustLeafNodesSize('width')(params);
  }

  /**
   * @description 自定义列头时, 叶子节点层级不定, 需要自动对齐其高度, 填充空白
   * ------------------------------------------------------------------------
   * |                       自定义节点 a-1                                   |
   * |----------------------------------------------------------------------|
   * |                 自定义节点 a-1-1               |                       |
   * |-------------|-------------|------------------|   自定义节点 a-1-2      |
   * |   指标 1    |  自定义节点 a-1-1-1    | 指标 2  |                        |
   * ----------------------------------------------------------------------
   */
  public adjustColLeafNodesHeight(params: AdjustLeafNodesParams) {
    if (!this.spreadsheet.isCustomColumnFields()) {
      return;
    }

    this.adjustLeafNodesSize('height')(params);
  }

  public adjustLeafNodesSize(type: 'width' | 'height') {
    return ({ leafNodes, hierarchy }: AdjustLeafNodesParams) => {
      const { sampleNodeForLastLevel, sampleNodesForAllLevels } = hierarchy;

      leafNodes.forEach((node) => {
        if (node.level > sampleNodeForLastLevel?.level!) {
          return;
        }

        const leafNodeSize = sumBy(sampleNodesForAllLevels, (sampleNode) => {
          if (sampleNode.level < node.level) {
            return 0;
          }

          return sampleNode[type];
        });

        node[type] = leafNodeSize;
      });
    };
  }
}
