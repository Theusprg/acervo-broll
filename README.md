# Acervo

Biblioteca de B-roll pro editor de vídeo. Funciona como um explorer: você aponta as pastas onde ficam os vídeos, imagens e áudios, vê tudo em miniatura e arrasta o arquivo direto pro CapCut, Premiere, DaVinci ou qualquer programa que aceite arquivos arrastados.

Roda no Windows e no Mac. Feito em Rust ([Tauri 2](https://tauri.app)) com a interface em HTML, CSS e JavaScript puro.

## Baixar e instalar

Os instaladores ficam na página **Releases** do repositório:

- **Windows:** `Acervo_x.y.z_x64-setup.exe` (ou o `.msi`)
- **Mac:** `Acervo_x.y.z_universal.dmg` (serve pra Mac Intel e Apple Silicon)

O app ainda não tem assinatura paga da Microsoft/Apple, então na primeira vez o sistema avisa:

- **Windows:** aparece "O Windows protegeu o computador". Clique em **Mais informações** e depois **Executar assim mesmo**.
- **Mac:** abra o `.dmg` e arraste o Acervo pra pasta Aplicativos. Na primeira vez, clique com o botão direito no app e escolha **Abrir**. Se o macOS não deixar, vá em **Ajustes do Sistema > Privacidade e Segurança** e clique em **Abrir Mesmo Assim**.

## Como usar

1. Na primeira vez, clique em **Escolher pasta** (ou **Criar pasta nova em Vídeos**). Dá pra adicionar várias pastas no **+** de Bibliotecas, inclusive de HD externo ou de pasta do Google Drive.
2. Navegue pelas pastas na lateral. Passe o mouse num vídeo pra ver o clipe inteiro correndo o cursor de um lado pro outro.
3. **Arraste o card pro editor.** Pra mandar vários de uma vez, selecione com Ctrl (no Mac, Cmd) ou Shift e arraste qualquer um deles.

Os arquivos continuam onde estão. O Acervo não copia nada pra lugar nenhum, só mostra e organiza.

### Mais coisas que ele faz

- **Busca** em todas as bibliotecas pelo nome do arquivo e das pastas ("praia drone" acha `Praia/Drone/clipe_03.mp4`). O botão ao lado da busca troca pra buscar só na pasta aberta.
- **Filtros** por tipo (vídeos, imagens, áudios) e por formato (horizontal ou vertical 9:16, bom pra Reels e TikTok).
- **Favoritos** (estrela no card), **Usados recentemente** (tudo que foi arrastado pro editor) e **Adicionados recentemente**.
- **Prévia grande** com duplo clique ou Espaço, com setas pra passar pro próximo.
- **Importar:** arraste arquivos do Explorer/Finder pra dentro do app e eles são copiados pra pasta aberta. Soltar numa pasta da lateral copia pra ela.
- **Mover entre pastas:** arraste um card até uma pasta da lateral.
- Botão direito: renomear, mostrar no Explorer/Finder, abrir no programa padrão, copiar caminho, mandar pra Lixeira.

### Atalhos

| Ação | Windows | Mac |
| --- | --- | --- |
| Buscar | Ctrl F | Cmd F |
| Prévia | Espaço ou Enter | Espaço ou Enter |
| Selecionar tudo | Ctrl A | Cmd A |
| Favoritar | F | F |
| Renomear | F2 | F2 |
| Mandar pra Lixeira | Delete | Cmd Backspace |
| Voltar uma pasta | Backspace | Backspace |
| Atualizar | F5 | Cmd R |

## Onde ficam os dados

Tudo fica no computador de quem usa, nada vai pra internet:

- **Arquivos:** nas pastas que você escolheu.
- **Lista de pastas, favoritos e preferências:** `state.json` na pasta de configuração do app
  (Windows: `%APPDATA%\com.pauloaguiarx.acervo`, Mac: `~/Library/Application Support/com.pauloaguiarx.acervo`).
- **Miniaturas:** geradas uma vez e guardadas no cache
  (Windows: `%LOCALAPPDATA%\com.pauloaguiarx.acervo\thumbs`, Mac: `~/Library/Caches/com.pauloaguiarx.acervo/thumbs`). Pode apagar à vontade, elas são refeitas.

Formatos que o sistema não consegue mostrar na prévia (por exemplo `.mov` em ProRes ou HEVC no Windows) aparecem com o aviso "Sem prévia", mas arrastam pro editor normalmente.

## Desenvolvimento

Precisa de [Rust](https://rustup.rs), [Node 22](https://nodejs.org) e:

- **Windows:** Visual Studio Build Tools com "Desenvolvimento para desktop com C++" (WebView2 já vem no Windows 10/11).
- **Mac:** `xcode-select --install`.

```bash
npm install
npm run dev      # abre o app em modo desenvolvimento
npm run build    # gera o instalador do sistema atual em src-tauri/target/release/bundle
```

Pra mexer só na interface sem compilar o Rust, tem um backend de mentira com mídia gerada na hora:

```bash
node dev/serve.mjs   # http://localhost:5544  (http://localhost:5544/?vazio mostra a tela inicial)
```

Estrutura:

- `src/`: interface (`index.html`, `styles.css`, `app.js`).
- `src-tauri/src/main.rs`: comandos em Rust (listar pastas, busca, copiar/mover, lixeira, miniaturas, estado).
- O arrastar pra fora usa o plugin [`tauri-plugin-drag`](https://github.com/crabnebula-dev/drag-rs), que faz o arrasto nativo do sistema (OLE no Windows, NSDraggingSession no Mac).

### Lançar versão nova

1. Troque a versão em `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` e `package.json`.
2. Faça commit e crie a tag: `git tag v0.2.0 && git push --tags`.
3. O GitHub Actions compila Windows e Mac e publica os instaladores em Releases (uns 15 minutos).
