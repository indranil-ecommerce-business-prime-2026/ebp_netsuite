/**
 * NetSuite RESTlet Samples - SuiteScript 2.0
 * 
 * These are sample RESTlets demonstrating:
 * - GET requests (retrieve data)
 * - POST requests (create records)
 * - PUT requests (update records)
 * - DELETE requests (remove records)
 * - Error handling and validation
 */

// ============================================================================
// SAMPLE 1: Basic Customer RESTlet
// ============================================================================

/**
 * @NApiVersion 2.0
 * @NScriptType RESTlet
 * @NModuleScope SameAccount
 */

define(['N/record', 'N/search', 'N/error', 'N/http'], function(record, search, error, http) {
    
    /**
     * GET - Retrieve a customer by ID
     * Usage: GET /services/rest/v1/custom/restlet?script=1234&deploy=1&id=5678
     */
    function doGet(requestParams) {
        try {
            var customerId = requestParams.id;
            
            if (!customerId) {
                throw error.create({
                    name: 'MISSING_PARAM',
                    message: 'Customer ID is required'
                });
            }
            
            // Load the customer record
            var customerRecord = record.load({
                type: record.Type.CUSTOMER,
                id: customerId,
                isDynamic: false
            });
            
            // Return customer data
            return {
                success: true,
                data: {
                    id: customerRecord.id,
                    companyName: customerRecord.getValue('companyname'),
                    email: customerRecord.getValue('email'),
                    phone: customerRecord.getValue('phone'),
                    status: customerRecord.getValue('customersalutation')
                }
            };
            
        } catch(e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
    
    /**
     * POST - Create a new customer
     * Request body: {
     *   "companyName": "ABC Corp",
     *   "email": "contact@abc.com",
     *   "phone": "555-1234"
     * }
     */
    function doPost(requestBody) {
        try {
            // Parse the request body
            var data = JSON.parse(requestBody);
            
            // Validate required fields
            if (!data.companyName) {
                throw error.create({
                    name: 'INVALID_DATA',
                    message: 'Company name is required'
                });
            }
            
            // Create new customer record
            var customerRecord = record.create({
                type: record.Type.CUSTOMER,
                isDynamic: true
            });
            
            customerRecord.setValue({
                fieldId: 'companyname',
                value: data.companyName
            });
            
            if (data.email) {
                customerRecord.setValue({
                    fieldId: 'email',
                    value: data.email
                });
            }
            
            if (data.phone) {
                customerRecord.setValue({
                    fieldId: 'phone',
                    value: data.phone
                });
            }
            
            var recordId = customerRecord.save();
            
            return {
                success: true,
                message: 'Customer created successfully',
                customerId: recordId
            };
            
        } catch(e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
    
    /**
     * PUT - Update an existing customer
     * Usage: PUT /services/rest/v1/custom/restlet?script=1234&deploy=1&id=5678
     * Request body: {
     *   "email": "newemail@abc.com",
     *   "phone": "555-5678"
     * }
     */
    function doPut(requestParams, requestBody) {
        try {
            var customerId = requestParams.id;
            var data = JSON.parse(requestBody);
            
            if (!customerId) {
                throw error.create({
                    name: 'MISSING_PARAM',
                    message: 'Customer ID is required'
                });
            }
            
            // Load and update customer record
            var customerRecord = record.load({
                type: record.Type.CUSTOMER,
                id: customerId,
                isDynamic: true
            });
            
            if (data.companyName) {
                customerRecord.setValue({
                    fieldId: 'companyname',
                    value: data.companyName
                });
            }
            
            if (data.email) {
                customerRecord.setValue({
                    fieldId: 'email',
                    value: data.email
                });
            }
            
            if (data.phone) {
                customerRecord.setValue({
                    fieldId: 'phone',
                    value: data.phone
                });
            }
            
            customerRecord.save();
            
            return {
                success: true,
                message: 'Customer updated successfully',
                customerId: customerId
            };
            
        } catch(e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
    
    /**
     * DELETE - Remove a customer
     * Usage: DELETE /services/rest/v1/custom/restlet?script=1234&deploy=1&id=5678
     */
    function doDelete(requestParams) {
        try {
            var customerId = requestParams.id;
            
            if (!customerId) {
                throw error.create({
                    name: 'MISSING_PARAM',
                    message: 'Customer ID is required'
                });
            }
            
            // Delete the customer record
            record.delete({
                type: record.Type.CUSTOMER,
                id: customerId
            });
            
            return {
                success: true,
                message: 'Customer deleted successfully'
            };
            
        } catch(e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
    
    return {
        get: doGet,
        post: doPost,
        put: doPut,
        delete: doDelete
    };
});


// ============================================================================
// SAMPLE 2: Sales Order RESTlet with Line Items
// ============================================================================

/**
 * @NApiVersion 2.0
 * @NScriptType RESTlet
 * @NModuleScope SameAccount
 */

define(['N/record', 'N/search'], function(record, search) {
    
    function doGet(requestParams) {
        try {
            var orderId = requestParams.orderId;
            
            var salesOrder = record.load({
                type: record.Type.SALES_ORDER,
                id: orderId
            });
            
            // Get line items
            var lineCount = salesOrder.getLineCount({ sublistId: 'item' });
            var items = [];
            
            for (var i = 0; i < lineCount; i++) {
                items.push({
                    lineNum: i + 1,
                    itemId: salesOrder.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    }),
                    quantity: salesOrder.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    }),
                    rate: salesOrder.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'rate',
                        line: i
                    }),
                    amount: salesOrder.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'amount',
                        line: i
                    })
                });
            }
            
            return {
                success: true,
                data: {
                    orderId: orderId,
                    customer: salesOrder.getValue('entity'),
                    total: salesOrder.getValue('total'),
                    status: salesOrder.getValue('status'),
                    items: items
                }
            };
            
        } catch(e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
    
    function doPost(requestBody) {
        try {
            var data = JSON.parse(requestBody);
            
            if (!data.customerId || !data.items || data.items.length === 0) {
                throw new Error('Customer ID and items are required');
            }
            
            var salesOrder = record.create({
                type: record.Type.SALES_ORDER
            });
            
            salesOrder.setValue({
                fieldId: 'entity',
                value: data.customerId
            });
            
            // Add line items
            data.items.forEach(function(item, index) {
                salesOrder.insertLine({
                    sublistId: 'item',
                    line: index
                });
                
                salesOrder.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: index,
                    value: item.itemId
                });
                
                salesOrder.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: index,
                    value: item.quantity
                });
            });
            
            var orderId = salesOrder.save();
            
            return {
                success: true,
                message: 'Sales Order created successfully',
                orderId: orderId
            };
            
        } catch(e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
    
    return {
        get: doGet,
        post: doPost
    };
});


// ============================================================================
// SAMPLE 3: Saved Search RESTlet (Search and Filter Data)
// ============================================================================

/**
 * @NApiVersion 2.0
 * @NScriptType RESTlet
 * @NModuleScope SameAccount
 */

define(['N/search'], function(search) {
    
    /**
     * GET - Execute a saved search and return results
     * Usage: GET /services/rest/v1/custom/restlet?searchId=123&limit=100
     */
    function doGet(requestParams) {
        try {
            var searchId = requestParams.searchId;
            var limit = parseInt(requestParams.limit) || 100;
            
            if (!searchId) {
                throw new Error('Search ID is required');
            }
            
            // Load and run the saved search
            var savedSearch = search.load({
                id: searchId
            });
            
            var results = [];
            var searchResults = savedSearch.run().getRange({
                start: 0,
                end: limit
            });
            
            searchResults.forEach(function(result) {
                results.push({
                    id: result.id,
                    values: result.values
                });
            });
            
            return {
                success: true,
                resultCount: results.length,
                data: results
            };
            
        } catch(e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
    
    return {
        get: doGet
    };
});


// ============================================================================
// SAMPLE 4: Item RESTlet (Complex Record Operations)
// ============================================================================

/**
 * @NApiVersion 2.0
 * @NScriptType RESTlet
 * @NModuleScope SameAccount
 */

define(['N/record', 'N/error'], function(record, error) {
    
    function doGet(requestParams) {
        try {
            var itemId = requestParams.itemId;
            
            var item = record.load({
                type: record.Type.INVENTORY_ITEM,
                id: itemId
            });
            
            return {
                success: true,
                data: {
                    id: itemId,
                    itemName: item.getValue('itemid'),
                    description: item.getValue('description'),
                    quantity: item.getValue('quantityavailable'),
                    price: item.getValue('price'),
                    sku: item.getValue('upccode'),
                    type: item.getValue('itemtype'),
                    status: item.getValue('isinactive') ? 'Inactive' : 'Active'
                }
            };
            
        } catch(e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
    
    function doPost(requestBody) {
        try {
            var data = JSON.parse(requestBody);
            
            if (!data.itemName) {
                throw error.create({
                    name: 'MISSING_FIELD',
                    message: 'Item name is required'
                });
            }
            
            var item = record.create({
                type: record.Type.INVENTORY_ITEM
            });
            
            item.setValue({ fieldId: 'itemid', value: data.itemName });
            item.setValue({ fieldId: 'description', value: data.description || '' });
            item.setValue({ fieldId: 'price', value: data.price || 0 });
            
            var itemId = item.save();
            
            return {
                success: true,
                message: 'Item created successfully',
                itemId: itemId
            };
            
        } catch(e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
    
    return {
        get: doGet,
        post: doPost
    };
});