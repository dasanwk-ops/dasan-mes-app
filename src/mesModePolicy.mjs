// Pure deployment policy. A missing setting NEVER selects the factory database.
export function modePolicy({mode='demo',hostname='',allowedHost='',apiKey='',authDomain='',projectId='',allowWrites=false}) {
  let error='';
  if (!['demo','emulator','production'].includes(mode)) error='\uC54C \uC218 \uC5C6\uB294 MES \uBAA8\uB4DC\uC785\uB2C8\uB2E4.';
  if (mode==='production') {
    if (!allowedHost || hostname!==allowedHost) error='\uC6B4\uC601 \uC8FC\uC18C\uAC00 \uC544\uB2C8\uBBC0\uB85C \uACF5\uC7A5 \uB370\uC774\uD130\uC5D0 \uC5F0\uACB0\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.';
    else if (!apiKey || !authDomain || projectId!=='dasanind-mes') error='Firebase \uC6B4\uC601 \uC124\uC815\uC774 \uC5C6\uAC70\uB098 \uD655\uC778\uB41C \uD504\uB85C\uC81D\uD2B8\uC640 \uB2E4\uB985\uB2C8\uB2E4. \uC5F0\uACB0\uC744 \uCC28\uB2E8\uD569\uB2C8\uB2E4.';
  }
  if (mode==='emulator' && !['localhost','127.0.0.1'].includes(hostname)) error='Emulator \uC2DC\uD5D8\uC740 \uB85C\uCEEC \uCEF4\uD4E8\uD130\uC5D0\uC11C\uB9CC \uD5C8\uC6A9\uB429\uB2C8\uB2E4.';
  const selected=error?'blocked':mode;
  return {mode:selected,error,liveWrites:selected==='production' && allowWrites===true};
}
