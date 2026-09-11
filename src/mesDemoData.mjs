// Synthetic examples only; never copies the factory's inventory.
export function makeDemoData(root) {
  const output = {};
  const put = (col,id,data) => { output[`${root}/${col}/${id}`] = data; };
  const steps = ['step1','step2','step3','step4','step5','step6','step7','step7_drying','step8','done'];
  for (let i=0;i<steps.length;i++) {
    const id=`demo-wip-${i+1}`;
    put('wipList',id,{id,mixLot:`MIX-DEMO-${String(i+1).padStart(3,'0')}`,orderId:`demo-order-${i+1}`,type:'345 BL3',height:'25',singleWeight:650,weight:'6.765',qty:10,currentStep:steps[i],details:'[DEMO] Synthetic data - not factory inventory',...(i>=5?{shrinkageRate:'20.00',heatTreatmentHistory:[{furnaceId:'1',startedAt:'2026-09-01 08:00:00',completedAt:'2026-09-02 08:00:00',temperature:'1050',operator:'DEMO',slots:[]}]}:{}),...(i>=8?{packLot:`FDEMO00${i+1}`,packLotCreatedAt:'2026-09-03 08:00:00'}:{})});
    put('orderList',`demo-order-${i+1}`,{id:`demo-order-${i+1}`,orderNo:`ORD-DEMO-${i+1}`,orderDate:'2026-09-01',color:'345 BL3',height:'25',qty:20,singleWeight:650,status:'DEMO'});
  }
  for(const [i,type]of ['4Y-W','4Y-Y','5E-P','4Y-W-S','4Y-G'].entries())put('inventory',`demo-material-${i}`,{id:`demo-material-${i}`,type,lot:`RAW-DEMO-${i}`,weight:1000,date:'2026-09-01',status:'DEMO'});
  put('equipment','furnaces',{'1':{isHeating:false,temp:'1050',operator:'DEMO',memo:'',slotData:{}},'2':{isHeating:false,temp:'1050',operator:'DEMO',memo:'',slotData:{}}});
  put('equipment','dryingRoom',{cartItems:[],dryingWipIds:['demo-wip-8'],temp:'40',humidity:'15',operator:'DEMO',completionData:{},isDrying:false});
  put('equipment','shrinkDesks',{'1':{step:0,slotData:{},queue:[],memo:'',operator:''},'2':{step:0,slotData:{},queue:[],memo:'',operator:''}});
  return output;
}
