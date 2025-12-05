eps = 0.02; // epsilon
$fn = 40;



/*translate([0, -105, -36])
bolt();*/
rotate([90,0,0])
 translate([-7,7.5,30])

cap();

union()
{
    difference()
    {
         import("/home/alex/Desktop/files/Base C-Clamp 40 Body v5.stl");
        translate([-25, -eps, -eps])
        cube([30, 40, 15 + (eps*2)]);
    }
          
    difference()
    {   
        translate([-25, 0, 0])
        cube([35, 20, 15]);
    
        translate([-7.5, -5, -eps])
        cylinder(h=15 + (eps*2), d=25);
    }
    
     
}

difference()
{

    translate([-25, -30, 0])
            cube([35, 20, 15]);

    translate([-7.5, -5, -eps])
            cylinder(h=15 + (eps  * 2), d=25);
    
    /*translate([-7, -30, 7.5]) 
            sphere(d=10);*/
}


   
module bolt()
{
         rotate([270, 0, 0]) 
        import("/home/alex/Desktop/files/Base C-Clamp 40 Bolt Cap.stl");
}

module interlock()
{
    
    rotate([90,0,0]) 
    cylinder( h=10, d1=10, d2=8);

}

/*difference()
{
    import("/home/alex/Downloads/files/Base C-Clamp 40 Body v5.stl");
    
    translate([-25, -75, -0.01])
        cube([30, 30, 20]);
}*/


module screwhole()
{
    difference()
    {
        import("/home/alex/Downloads/files/Base C-Clamp 40 Body v5.stl");

        translate([-75, -48, -0.01])
            cube([80, 80, 30]);
        
        translate([-55, -70, -eps])
            cube([40, 30, 16]);
        
        translate([-22, -77, 18])
        {
            rotate([0, 45, 0])
            {
                cube ([10, 30, 10]);
                translate([14, 0,-15])
                        translate([0, -50, 15])
    {
        rotate([180, 0, 0])
        {
            intersection()
            {
                import("/home/alex/Downloads/files/Base C-Clamp 40 Body v5.stl");
                
                translate([-25, -10, -0.01])
                    cube([30, 30, 20]);
            }
        }
    }cube ([11, 30, 10]);
            }
        }
    }
}

module tip()
{
        translate([0, -50, 15])
    {
        rotate([180, 0, 0])
        {
            intersection()
            {
                import("/home/alex/Downloads/files/Base C-Clamp 40 Body v5.stl");
                
                translate([-25, -10, -0.01])
                    cube([30, 30, 20]);
            }
        }
    }
    
}

module cap()
{
    difference()
{
    cylinder(h=7, d1=15, d2=10);
    slot();
    rotate([0,0,125])
    slot();
    rotate([0,0,-125])
    slot();
    translate([0, 0, 5])
    sphere(d=8);
}


module slot()
{
    translate([4,0,4.5])
    cube([ 8, 3, 5], true) ;    
}
}

    