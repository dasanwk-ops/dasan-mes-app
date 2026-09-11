// Optional developer check. Requires TypeScript or MES_TYPESCRIPT_PATH.
// This is syntax/name checking, NOT an npm build or full JS type-check.
const ts=require(process.env.MES_TYPESCRIPT_PATH||'typescript');
const fs=require('fs'),path=require('path');const base=path.resolve(__dirname,'../src');
const files=fs.readdirSync(base).filter(f=>/\.(js|mjs|jsx)$/.test(f)).map(f=>path.join(base,f));
let parseErrors=[];
for(const file of files){const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.ES2022,true,file.endsWith('App.js')?ts.ScriptKind.JSX:ts.ScriptKind.JS);for(const d of tree.parseDiagnostics){const l=tree.getLineAndCharacterOfPosition(d.start);parseErrors.push(`${path.basename(file)}:${l.line+1}: ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`);}}
console.log(parseErrors.length?parseErrors.join('\n'):'All source files: syntax parse PASS');
const program=ts.createProgram(files,{allowJs:true,checkJs:true,noEmit:true,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.NodeJs,skipLibCheck:true});
const diagnostics=ts.getPreEmitDiagnostics(program);
const important=diagnostics.filter(d=>[2304,2552,2305,2451,2448].includes(d.code)&&!['process'].some(x=>ts.flattenDiagnosticMessageText(d.messageText,' ').includes("'"+x+"'")));
for(const d of important){const l=d.file?.getLineAndCharacterOfPosition(d.start);console.log(`${path.basename(d.file?.fileName||'')}:${l?l.line+1:0} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`);}
console.log(`Unresolved/duplicate identifiers: ${important.length}. Other untyped JS diagnostics: ${diagnostics.length-important.length} (not a type-check pass).`);
process.exitCode=parseErrors.length||important.length?1:0;
