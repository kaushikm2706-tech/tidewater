import { studioTheme } from 'ag-studio';

/** "Nocturnal harbour" palette applied through Studio's theming API. */
export const tidewaterTheme = studioTheme.withParams({
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  backgroundColor: '#0a1322',
  foregroundColor: '#d7e3f4',
  textColor: '#d7e3f4',
  borderColor: 'rgba(148,163,184,.16)',
  accentColor: '#2dd4bf',
  studioCanvasBackgroundColor: '#060b14',
  studioWidgetBackgroundColor: '#0a1322',
  studioWrapperBackgroundColor: '#060b14',
  studioPanelContainerBackgroundColor: '#0a1322',
  studioWidgetBorderRadius: 14,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleTextColor: '#e6f1ff',
  gridHeaderBackgroundColor: '#0c1a2e',
  gridDataBackgroundColor: '#0a1322',
  gridOddRowBackgroundColor: '#0c1626',
} as any);
