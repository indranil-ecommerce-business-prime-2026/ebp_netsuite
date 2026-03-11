

import { Router } from 'express'
import { syncMasterListToSuiteList } from '../controller'
import { addSuiteClass } from '../controller/add_class';
import { getSuiteList } from '../controller/suite_list';
import { sales_order } from '../controller/sales_order';
import { get_all_sales_orders } from '../controller/get_list';

const route = Router()
route.get('/sync', syncMasterListToSuiteList)
route.post("/suite-class", addSuiteClass);
route.get("/suite-list", getSuiteList);
route.get("/suite-salesOrder", sales_order);
route.get("/sales-orders", get_all_sales_orders);

export default route