# DeepClean PC (v2.5 Design Edition)

Aplicação Desktop Nativa (Electron) para Windows focada em:
- **Desinstalador Pro**: Lista programas Win32, jogos e apps da Microsoft Store com ícones nativos reais, executa o desinstalador oficial e vasculha automaticamente `AppData`, `ProgramData` e `Program Files` para limpar pastas residuais.
- **Caçador de Programas Fantasmas & Pastas Órfãs**: Cruza o Registro do Windows com os diretórios do sistema para revelar programas ocultos/portáteis fora do painel do Windows e sobras de programas antigos.
- **Rastreador de Arquivos Esquecidos & Caches Dev**: Encontra instaladores, vídeos, arquivos compactados e pastas pesadas de projetos (`node_modules`, `.venv`, `target`) sem uso há meses.
- **Limpeza Rápida (Estilo CCleaner)**: Limpa caches temporários seguros (`%TEMP%`, `Windows\Temp`, `Prefetch`, `CrashDumps`, `WER`, `npm-cache`, `pip`, `D3DSCache`).
- **Migração entre Discos sem Quebrar (`C:` ↔ `E:`)**: Transfere pastas de programas/jogos ou arquivos pesados entre unidades de disco usando `Robocopy` e cria **Junções NTFS Transparentes (`mklink /J`)** para que atalhos e o Registro continuem funcionando sem quebrar nada.

## Como Executar

1. Instale as dependências:
   ```powershell
   npm install
   ```
2. Inicie o aplicativo:
   ```powershell
   npm start
   ```
   Ou dê dois cliques em `Iniciar-DeepClean.bat`.
