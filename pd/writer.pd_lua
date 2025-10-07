local writer = pd.Class:new():register("writer")

function writer:initialize(name, args)
    -- one inlet, no outlets
    self.inlets = 1
    self.outlets = 0
    
    -- give each instance a unique filename based on creation arguments
    -- local directory = self.directory()
    local id = tostring(self)   -- unique-ish string for this instance
    local path = dir .. "/output_" .. id .. ".txt"  -- '..' will concatenate strings

    self.fh = io.open(path, "w")
    if not self.fh then
        pd.post("Could not open output.txt for writing")
    else
        pd.post("[" .. name .. ") writing to " .. path)
    end
    
    return true
end

function writer:in_1_symbol(msg)
    if self.fh then
        self.fh:write(msg .. "\n")
        self.fh:flush()
    end
end

function writer:in_1_list(list)
    if self.fh then
        for i, v in ipairs(list) do
            self.fh:write(tostring(v) .. " ")
        end
        self.fh:write("\n")
        self.fh:flush()
    end
end

function writer:finalize()
    if self.fh then
        self.fh:close()
        self.fh = nil
    end
end
