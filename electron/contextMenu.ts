// Menu nativo do botão direito em campos de texto e sobre texto selecionado. O resto da interface tem os menus dela:
// quando ela abre um (preventDefault no contextmenu), o Chromium nem emite o 'context-menu' para o processo principal.
// Só tipos do Electron aqui, para dar para testar com o Node, sem abrir o app.
import type { ContextMenuParams, MenuItemConstructorOptions, PopupOptions } from 'electron';

/** Itens do menu de edição para o ponto clicado; vazio quando não é um campo nem há texto selecionado. */
export function editMenuTemplate(params: Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>): MenuItemConstructorOptions[] {
  const flags = params.editFlags;
  if (params.isEditable) {
    return [
      { role: 'cut', label: 'Recortar', enabled: flags.canCut },
      { role: 'copy', label: 'Copiar', enabled: flags.canCopy },
      { role: 'paste', label: 'Colar', enabled: flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: 'Selecionar tudo', enabled: flags.canSelectAll },
    ];
  }
  if (!params.selectionText.trim()) return [];
  return [
    { role: 'copy', label: 'Copiar', enabled: flags.canCopy },
    { type: 'separator' },
    { role: 'selectAll', label: 'Selecionar tudo', enabled: flags.canSelectAll },
  ];
}

/**
 * Onde o menu aparece: no ponto do clique ou, pelo teclado (Shift+F10, tecla Menu), junto do campo ou da seleção, que o
 * Chromium já manda em x e y. Sem isso, o Electron o abre onde estiver o ponteiro do mouse, longe do campo. A origem
 * (mouse ou teclado) faz o Windows e o Linux abrirem o menu já no modo teclado, com o primeiro item destacado.
 */
export function editMenuPopupOptions(
  params: Pick<ContextMenuParams, 'x' | 'y' | 'menuSourceType' | 'frame'>,
): Pick<PopupOptions, 'x' | 'y' | 'sourceType' | 'frame'> {
  return { x: params.x, y: params.y, sourceType: params.menuSourceType, frame: params.frame ?? undefined };
}
