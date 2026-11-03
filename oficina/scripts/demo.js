'use strict';
// npm run demo: arranca la oficina con agentes simulados. Fija la variable aquí porque
// «VAR=1 node …» no funciona en la consola de Windows.
process.env.AI_OFFICE_DEMO = '1';
require('../src/servidor.js');
