# Corretor de Gabaritos CEFET-MG

PWA estatico para corrigir a folha de respostas por scanner ao vivo no celular ou tablet. O modo por foto continua disponivel como backup.

## Como testar localmente

Na pasta `Provas`, execute:

```powershell
python -m http.server 8092 --directory corretor_pwa
```

Depois acesse `http://localhost:8092` no computador. Camera ao vivo no celular exige HTTPS; para celular, use o GitHub Pages.

## Como publicar no GitHub Pages

1. Crie um repositorio publico no GitHub, por exemplo `corretor-gabaritos`.
2. Envie todo o conteudo desta pasta `corretor_pwa` para a raiz do repositorio. A pasta `data/` precisa ir junto.
3. No GitHub, abra **Settings > Pages**.
4. Em **Build and deployment**, escolha **Deploy from a branch**.
5. Selecione a branch `main` e a pasta `/(root)`.
6. Aguarde o GitHub informar o endereco publicado.
7. Teste se estes enderecos abrem antes de usar:
   - `/data/gabaritos.json`
   - `/data/layout_gabarito.json`

O endereco deve ficar parecido com:

```text
https://apereirafabiana.github.io/corretor-gabaritos/
```

## Como instalar no celular

1. Abra o endereco publicado no navegador do celular.
2. No Chrome/Android, toque no menu e escolha **Adicionar a tela inicial** ou **Instalar app**.
3. No iPad/iPhone, use o botao de compartilhar e escolha **Adicionar a Tela de Inicio**.

Depois do primeiro acesso, o service worker mantem o app disponivel offline. Se uma versao antiga ficar presa no celular, limpe os dados do site no navegador e abra de novo.

## Privacidade

As fotos e notas sao processadas no proprio navegador. Nada e enviado para servidor.

## Arquivos de prova usados

- `data/gabaritos.json`
- `data/layout_gabarito.json`

Sempre que a prova ou a folha de respostas forem regeneradas, copie novamente esses dois arquivos para `corretor_pwa/data/`.
