
local file ourTextFile = nil
local mydata = pd.Class:new():register("mydata")


-- this is a comment!

function mydata:initialize(name, atoms)
    if #atoms > 0 then self:openOurTextFile(atoms[1]) 
    end
    
    if ourTextFile == nil then pd.post("mydata:initialize: unable to open ") end
    self.inlets = 1
    self.outlets = 3
    return true
end

function mydata:postinitialize()
end

function mydata:finalize()
end
